use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};
use wasapi::{
    AudioClient, AudioRenderClient, DeviceEnumerator, Direction, Handle, SampleType, ShareMode,
    StreamMode, TimingMode, WasapiError, WaveFormat, calculate_period_100ns, initialize_mta,
};
use windows::Win32::Media::Audio::{
    AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE,
    AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_E_UNSUPPORTED_FORMAT,
};
use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
use windows::core::w;

use crate::audio::{Shared, now_us};
use crate::click::Renderer;
use crate::protocol::ProtoError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    LowLatency,
    Exclusive,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::LowLatency => "lowlatency",
            Mode::Exclusive => "exclusive",
        }
    }
}

pub struct StartConfig {
    pub device_id: String,
    pub mode: Mode,
    pub sample_rate: u32,
    pub buffer_frames: u32,
}

pub struct WasapiStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub info: Value,
}

impl Drop for WasapiStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn audio_error(message: impl Into<String>) -> ProtoError {
    ProtoError::new("audio_error", message)
}

fn describe(error: &WasapiError) -> String {
    if let WasapiError::Windows(inner) = error {
        let code = inner.code();
        if code == AUDCLNT_E_DEVICE_IN_USE {
            return "another application has exclusive control of this device".to_string();
        }
        if code == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
            return "exclusive mode is disabled for this device. Enable \"Allow applications to take exclusive control of this device\" in the Windows sound settings".to_string();
        }
        if code == AUDCLNT_E_UNSUPPORTED_FORMAT {
            return "the device rejected the audio format".to_string();
        }
    }
    error.to_string()
}

fn endpoint_id(device_id: &str) -> &str {
    device_id.strip_prefix("wasapi:").unwrap_or(device_id)
}

#[derive(Clone, Copy, Debug)]
enum Encoding {
    Float32,
    Int16,
    Int24Packed,
    Int32 { valid_bits: u16 },
}

impl Encoding {
    fn of(format: &WaveFormat) -> Result<Self, ProtoError> {
        let kind = format
            .get_subformat()
            .map_err(|e| audio_error(e.to_string()))?;
        let bits = format.get_bitspersample();
        let valid = format.get_validbitspersample();
        match (kind, bits) {
            (SampleType::Float, 32) => Ok(Encoding::Float32),
            (SampleType::Int, 16) => Ok(Encoding::Int16),
            (SampleType::Int, 24) => Ok(Encoding::Int24Packed),
            (SampleType::Int, 32) => Ok(Encoding::Int32 { valid_bits: valid }),
            _ => Err(audio_error(format!(
                "unsupported device format {bits} bit {kind:?}"
            ))),
        }
    }

    fn convert(self, input: &[f32], out: &mut [u8]) {
        match self {
            Encoding::Float32 => {
                let (chunks, _) = out.as_chunks_mut::<4>();
                for (sample, chunk) in input.iter().zip(chunks) {
                    chunk.copy_from_slice(&sample.to_le_bytes());
                }
            }
            Encoding::Int16 => {
                let (chunks, _) = out.as_chunks_mut::<2>();
                for (sample, chunk) in input.iter().zip(chunks) {
                    let v = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                    chunk.copy_from_slice(&v.to_le_bytes());
                }
            }
            Encoding::Int24Packed => {
                let (chunks, _) = out.as_chunks_mut::<3>();
                for (sample, chunk) in input.iter().zip(chunks) {
                    let v = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                    chunk.copy_from_slice(&v.to_le_bytes()[..3]);
                }
            }
            Encoding::Int32 { valid_bits } => {
                let (chunks, _) = out.as_chunks_mut::<4>();
                for (sample, chunk) in input.iter().zip(chunks) {
                    let clamped = f64::from(sample.clamp(-1.0, 1.0));
                    let v = if valid_bits >= 32 {
                        (clamped * 2_147_483_647.0).round() as i32
                    } else {
                        ((clamped * 8_388_607.0).round() as i32) << 8
                    };
                    chunk.copy_from_slice(&v.to_le_bytes());
                }
            }
        }
    }
}

struct Setup {
    client: AudioClient,
    render: AudioRenderClient,
    event: Handle,
    encoding: Encoding,
    channels: usize,
    rate: u32,
    block: usize,
    buffer_frames: usize,
    period_frames: usize,
    stream_latency_ns: f64,
    info: Value,
}

fn exclusive_candidates(rate: u32, channels: usize) -> Vec<WaveFormat> {
    let c = channels;
    vec![
        WaveFormat::new(32, 24, SampleType::Int, rate as usize, c, None),
        WaveFormat::new(24, 24, SampleType::Int, rate as usize, c, None),
        WaveFormat::new(32, 32, SampleType::Int, rate as usize, c, None),
        WaveFormat::new(16, 16, SampleType::Int, rate as usize, c, None),
        WaveFormat::new(32, 32, SampleType::Float, rate as usize, c, None),
    ]
}

fn open_client(device_id: &str) -> Result<(AudioClient, String, wasapi::Device), ProtoError> {
    let enumerator = DeviceEnumerator::new().map_err(|e| audio_error(e.to_string()))?;
    let device = if device_id.is_empty() {
        enumerator.get_default_device(Direction::Render)
    } else {
        enumerator.get_device(endpoint_id(device_id))
    }
    .map_err(|e| audio_error(format!("output device not found: {e}")))?;
    let name = device.get_friendlyname().unwrap_or_default();
    let client = device
        .get_iaudioclient()
        .map_err(|e| audio_error(e.to_string()))?;
    Ok((client, name, device))
}

fn setup_low_latency(cfg: &StartConfig) -> Result<Setup, ProtoError> {
    let (mut client, name, _device) = open_client(&cfg.device_id)?;
    let mix = client
        .get_mixformat()
        .map_err(|e| audio_error(e.to_string()))?;
    let range = client.get_shared_mode_engine_period(&mix).map_err(|e| {
        audio_error(format!(
            "the driver does not support low-latency shared mode: {e}"
        ))
    })?;
    let mut frames = if cfg.buffer_frames == 0 {
        range.min
    } else {
        cfg.buffer_frames.clamp(range.min, range.max)
    };
    if range.fundamental > 0 {
        let steps = frames.saturating_sub(range.min).div_ceil(range.fundamental);
        frames = (range.min + steps * range.fundamental).min(range.max);
    }
    client
        .initialize_shared_audio_stream(&mix, TimingMode::Events, frames)
        .map_err(|e| audio_error(describe(&e)))?;
    finish_setup(
        client,
        mix,
        name,
        Mode::LowLatency,
        Some((range.min, range.default, range.max)),
        Some(frames as usize),
    )
}

fn setup_exclusive(cfg: &StartConfig) -> Result<Setup, ProtoError> {
    let (mut client, name, device) = open_client(&cfg.device_id)?;
    let mix = client
        .get_mixformat()
        .map_err(|e| audio_error(e.to_string()))?;
    let rate = if cfg.sample_rate == 0 {
        mix.get_samplespersec()
    } else {
        cfg.sample_rate
    };
    let channels = usize::from(mix.get_nchannels().min(2));
    let mut chosen = None;
    for candidate in exclusive_candidates(rate, channels) {
        if let Ok(found) = client.is_supported_exclusive_with_quirks(&candidate) {
            chosen = Some(found);
            break;
        }
    }
    let format = chosen.ok_or_else(|| {
        audio_error(format!(
            "the device does not accept an exclusive-mode format at {rate} Hz"
        ))
    })?;
    let (_default_period, min_period) = client
        .get_device_period()
        .map_err(|e| audio_error(e.to_string()))?;
    let desired = if cfg.buffer_frames == 0 {
        min_period
    } else {
        calculate_period_100ns(i64::from(cfg.buffer_frames), i64::from(rate)).max(min_period)
    };
    let period = client
        .calculate_aligned_period_near(desired, Some(128), &format)
        .map_err(|e| audio_error(e.to_string()))?;
    let mode = StreamMode::EventsExclusive { period_hns: period };
    if let Err(first) = client.initialize_client(&format, Direction::Render, mode, None) {
        let aligned = matches!(&first, WasapiError::Windows(w) if w.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED);
        if !aligned {
            return Err(audio_error(describe(&first)));
        }
        let frames = client
            .get_buffer_size()
            .map_err(|e| audio_error(e.to_string()))?;
        let fixed =
            calculate_period_100ns(i64::from(frames), i64::from(format.get_samplespersec()));
        client = device
            .get_iaudioclient()
            .map_err(|e| audio_error(e.to_string()))?;
        client
            .initialize_client(
                &format,
                Direction::Render,
                StreamMode::EventsExclusive { period_hns: fixed },
                None,
            )
            .map_err(|e| audio_error(describe(&e)))?;
    }
    finish_setup(client, format, name, Mode::Exclusive, None, None)
}

fn finish_setup(
    client: AudioClient,
    format: WaveFormat,
    name: String,
    mode: Mode,
    shared_range: Option<(u32, u32, u32)>,
    period_frames: Option<usize>,
) -> Result<Setup, ProtoError> {
    let event = client
        .set_get_eventhandle()
        .map_err(|e| audio_error(e.to_string()))?;
    let render = client
        .get_audiorenderclient()
        .map_err(|e| audio_error(e.to_string()))?;
    let buffer_frames = client
        .get_buffer_size()
        .map_err(|e| audio_error(e.to_string()))? as usize;
    let latency_hns = client.get_stream_latency().unwrap_or(0);
    let rate = format.get_samplespersec();
    let channels = usize::from(format.get_nchannels());
    let block = format.get_blockalign() as usize;
    let encoding = Encoding::of(&format)?;
    let info = json!({
        "device": name,
        "mode": mode.label(),
        "sampleRate": rate,
        "channels": channels,
        "bufferFramesRequested": 0,
        "bufferFrames": buffer_frames,
        "periodMs": period_frames.unwrap_or(buffer_frames) as f64 / f64::from(rate) * 1000.0,
        "periodFrames": period_frames.unwrap_or(buffer_frames),
        "streamLatencyMs": latency_hns as f64 / 10_000.0,
        "format": format!("{:?} {} bit ({} valid)", encoding, format.get_bitspersample(), format.get_validbitspersample()),
        "sharedPeriodRange": shared_range.map(|(min, default, max)| json!({ "min": min, "default": default, "max": max })),
    });
    Ok(Setup {
        client,
        render,
        event,
        encoding,
        channels,
        rate,
        block,
        buffer_frames,
        period_frames: period_frames.unwrap_or(buffer_frames),
        stream_latency_ns: latency_hns as f64 * 100.0,
        info,
    })
}

fn render_loop(setup: Setup, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    let Setup {
        client,
        render,
        event,
        encoding,
        channels,
        rate,
        block,
        buffer_frames,
        period_frames,
        stream_latency_ns,
        ..
    } = setup;
    let mut renderer = Renderer::with_builtin(rate, channels);
    let period_us = (period_frames as f64 / f64::from(rate) * 1e6) as u64;
    let mut scratch = vec![0.0f32; buffer_frames * channels];
    let mut bytes = vec![0u8; buffer_frames * block];
    let mut task_index = 0u32;
    let _ = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) };

    let initial = client.get_available_space_in_frames().unwrap_or(0) as usize;
    if initial > 0 {
        bytes[..initial * block].fill(0);
        let _ = render.write_to_device(&bytes[..initial * block], None);
    }
    if client.start_stream().is_err() {
        return;
    }
    let mut last_wake_us = 0u64;
    while !stop.load(Ordering::Acquire) {
        if event.wait_for_event(50).is_err() {
            continue;
        }
        let wake_us = now_us();
        if last_wake_us != 0 && wake_us - last_wake_us > period_us * 2 {
            shared.note_late_wake();
        }
        last_wake_us = wake_us;
        let Ok(available) = client.get_available_space_in_frames() else {
            continue;
        };
        let frames = (available as usize).min(buffer_frames);
        if frames == 0 {
            continue;
        }
        let queued = buffer_frames - frames;
        renderer.apply(&shared.controls);
        let started = renderer.render(&mut scratch[..frames * channels]);
        encoding.convert(&scratch[..frames * channels], &mut bytes[..frames * block]);
        if render
            .write_to_device(&bytes[..frames * block], None)
            .is_err()
        {
            continue;
        }
        shared.note_callback(frames as u32);
        if let Some(id) = started {
            let playback_ns = queued as f64 / f64::from(rate) * 1e9 + stream_latency_ns;
            shared.report_click(id, wake_us, playback_ns as u64, frames as u32);
        }
    }
    let _ = client.stop_stream();
}

pub fn start(cfg: &StartConfig, shared: Arc<Shared>) -> Result<WasapiStream, ProtoError> {
    let (ready_tx, ready_rx): (SyncSender<Result<Value, ProtoError>>, _) = mpsc::sync_channel(1);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let config = StartConfig {
        device_id: cfg.device_id.clone(),
        mode: cfg.mode,
        sample_rate: cfg.sample_rate,
        buffer_frames: cfg.buffer_frames,
    };
    let thread = thread::Builder::new()
        .name("wasapi-render".into())
        .spawn(move || {
            let _ = initialize_mta();
            let setup = match config.mode {
                Mode::LowLatency => setup_low_latency(&config),
                Mode::Exclusive => setup_exclusive(&config),
            };
            match setup {
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
                Ok(setup) => {
                    let _ = ready_tx.send(Ok(setup.info.clone()));
                    render_loop(setup, shared, thread_stop);
                }
            }
        })
        .map_err(|e| audio_error(e.to_string()))?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(info)) => Ok(WasapiStream {
            stop,
            thread: Some(thread),
            info,
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            stop.store(true, Ordering::Release);
            Err(audio_error("the WASAPI stream did not start in time"))
        }
    }
}

pub fn probe(requested_rate: u32) -> Value {
    let _ = initialize_mta();
    let Ok(enumerator) = DeviceEnumerator::new() else {
        return json!([]);
    };
    let Ok(collection) = enumerator.get_device_collection(Direction::Render) else {
        return json!([]);
    };
    let count = collection.get_nbr_devices().unwrap_or(0);
    let mut out = Vec::new();
    for index in 0..count {
        let Ok(device) = collection.get_device_at_index(index) else {
            continue;
        };
        let name = device.get_friendlyname().unwrap_or_default();
        let id = device.get_id().unwrap_or_default();
        let Ok(client) = device.get_iaudioclient() else {
            continue;
        };
        let mix = client.get_mixformat().ok();
        let rate = if requested_rate == 0 {
            mix.as_ref().map(|m| m.get_samplespersec()).unwrap_or(48000)
        } else {
            requested_rate
        };
        let shared = mix
            .as_ref()
            .and_then(|m| client.get_shared_mode_engine_period(m).ok())
            .map(|p| {
                json!({
                    "defaultFrames": p.default,
                    "fundamentalFrames": p.fundamental,
                    "minFrames": p.min,
                    "maxFrames": p.max,
                    "minMs": f64::from(p.min) / f64::from(rate) * 1000.0,
                    "defaultMs": f64::from(p.default) / f64::from(rate) * 1000.0,
                })
            });
        let periods = client.get_device_period().ok();
        let mut format_name = Value::Null;
        for candidate in exclusive_candidates(rate, 2) {
            if client
                .is_supported(&candidate, ShareMode::Exclusive)
                .is_ok()
            {
                format_name = json!(format!(
                    "{} bit ({} valid) {}",
                    candidate.get_bitspersample(),
                    candidate.get_validbitspersample(),
                    candidate
                        .get_subformat()
                        .map(|s| format!("{s:?}"))
                        .unwrap_or_default()
                ));
                break;
            }
        }
        out.push(json!({
            "id": format!("wasapi:{id}"),
            "name": name,
            "mixRate": mix.as_ref().map(|m| m.get_samplespersec()),
            "shared": shared,
            "exclusive": {
                "supported": !format_name.is_null(),
                "format": format_name,
                "defaultMs": periods.map(|p| p.0 as f64 / 10_000.0),
                "minMs": periods.map(|p| p.1 as f64 / 10_000.0),
            },
        }));
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int16_conversion_hits_full_scale_and_clamps() {
        let mut out = [0u8; 6];
        Encoding::Int16.convert(&[1.0, -1.0, 2.0], &mut out);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 32767);
        assert_eq!(i16::from_le_bytes([out[2], out[3]]), -32767);
        assert_eq!(i16::from_le_bytes([out[4], out[5]]), 32767);
    }

    #[test]
    fn packed_24_bit_conversion_uses_three_bytes_little_endian() {
        let mut out = [0u8; 6];
        Encoding::Int24Packed.convert(&[1.0, -0.5], &mut out);
        assert_eq!(out[..3], [0xFF, 0xFF, 0x7F]);
        let half = i32::from_le_bytes([out[3], out[4], out[5], 0xFF]);
        assert_eq!(half, -4_194_304);
    }

    #[test]
    fn int32_with_24_valid_bits_leaves_the_low_byte_clear() {
        let mut out = [0u8; 4];
        Encoding::Int32 { valid_bits: 24 }.convert(&[1.0], &mut out);
        assert_eq!(out[0], 0);
        assert_eq!(i32::from_le_bytes(out), 8_388_607 << 8);
    }

    #[test]
    fn int32_with_32_valid_bits_uses_full_scale() {
        let mut out = [0u8; 4];
        Encoding::Int32 { valid_bits: 32 }.convert(&[-1.0], &mut out);
        assert_eq!(i32::from_le_bytes(out), -2_147_483_647);
    }

    #[test]
    fn float_conversion_is_bit_exact() {
        let mut out = [0u8; 8];
        Encoding::Float32.convert(&[0.25, -0.75], &mut out);
        assert_eq!(f32::from_le_bytes([out[0], out[1], out[2], out[3]]), 0.25);
        assert_eq!(f32::from_le_bytes([out[4], out[5], out[6], out[7]]), -0.75);
    }

    #[test]
    fn endpoint_ids_drop_the_cpal_prefix() {
        assert_eq!(endpoint_id("wasapi:{0.0.0.0}.{abc}"), "{0.0.0.0}.{abc}");
        assert_eq!(endpoint_id("{0.0.0.0}.{abc}"), "{0.0.0.0}.{abc}");
    }
}
