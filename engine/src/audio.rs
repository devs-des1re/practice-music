use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, DeviceId, OutputCallbackInfo, SampleFormat, StreamConfig};
use serde_json::{Value, json};

use crate::click::{Controls, Renderer};
use crate::protocol::{ProtoError, event_frame};
#[cfg(windows)]
use crate::wasapi_backend::{self, Mode, StartConfig, WasapiStream};

const SLOTS: usize = 64;

pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

pub struct Params {
    pub host: String,
    pub output_device: String,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    pub mode: String,
}

pub struct Shared {
    pub controls: Controls,
    report_seq: AtomicU64,
    report_callback_us: AtomicU64,
    report_playback_ns: AtomicU64,
    report_frames: AtomicU32,
    recv_us: [AtomicU64; SLOTS],
    callbacks: AtomicU64,
    last_frames: AtomicU32,
    late_wakes: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            controls: Controls::new(),
            report_seq: AtomicU64::new(0),
            report_callback_us: AtomicU64::new(0),
            report_playback_ns: AtomicU64::new(0),
            report_frames: AtomicU32::new(0),
            recv_us: std::array::from_fn(|_| AtomicU64::new(0)),
            callbacks: AtomicU64::new(0),
            last_frames: AtomicU32::new(0),
            late_wakes: AtomicU64::new(0),
        }
    }

    #[cfg(windows)]
    pub fn note_late_wake(&self) {
        self.late_wakes.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_callback(&self, frames: u32) {
        self.callbacks.fetch_add(1, Ordering::Relaxed);
        self.last_frames.store(frames, Ordering::Relaxed);
    }

    pub fn report_click(&self, id: u64, callback_us: u64, playback_ns: u64, frames: u32) {
        self.report_callback_us
            .store(callback_us, Ordering::Relaxed);
        self.report_playback_ns
            .store(playback_ns, Ordering::Relaxed);
        self.report_frames.store(frames, Ordering::Relaxed);
        self.report_seq.store(id, Ordering::Release);
    }

    pub fn reported_callback_us(&self, id: u64) -> Option<u64> {
        if self.report_seq.load(Ordering::Acquire) >= id {
            Some(self.report_callback_us.load(Ordering::Relaxed))
        } else {
            None
        }
    }

    pub fn trigger(&self, recv_us: u64) -> u64 {
        let id = self.controls.trigger();
        self.recv_us[(id as usize) % SLOTS].store(recv_us, Ordering::Release);
        id
    }
}

#[allow(dead_code)]
enum Backend {
    Cpal(cpal::Stream),
    #[cfg(windows)]
    Wasapi(WasapiStream),
}

pub struct AudioHandle {
    _stream: Backend,
    pub shared: Arc<Shared>,
    pub info: Value,
    stop: Arc<AtomicBool>,
    reporter: Option<JoinHandle<()>>,
}

impl AudioHandle {
    pub fn status(&self) -> Value {
        json!({
            "running": true,
            "callbacks": self.shared.callbacks.load(Ordering::Relaxed),
            "lastBufferFrames": self.shared.last_frames.load(Ordering::Relaxed),
            "lateWakes": self.shared.late_wakes.load(Ordering::Relaxed),
            "metronome": {
                "running": self.shared.controls.running(),
                "bpm": self.shared.controls.bpm(),
                "volume": self.shared.controls.volume(),
                "beatsPerBar": self.shared.controls.beats_per_bar(),
            },
            "info": self.info,
        })
    }
}

impl Drop for AudioHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.reporter.take() {
            let _ = handle.join();
        }
    }
}

fn audio_error(message: impl Into<String>) -> ProtoError {
    ProtoError::new("audio_error", message)
}

fn pick_host(wanted: &str, device_id: Option<&DeviceId>) -> Result<cpal::Host, ProtoError> {
    if let Some(id) = device_id {
        return cpal::host_from_id(id.host()).map_err(|e| audio_error(e.to_string()));
    }
    if wanted.is_empty() {
        return Ok(cpal::default_host());
    }
    let found = cpal::available_hosts()
        .into_iter()
        .find(|h| h.to_string() == wanted)
        .ok_or_else(|| audio_error(format!("audio driver {wanted} is not available")))?;
    cpal::host_from_id(found).map_err(|e| audio_error(e.to_string()))
}

pub fn start(params: &Params, events: Sender<String>) -> Result<AudioHandle, ProtoError> {
    match params.mode.as_str() {
        "" | "shared" => start_shared(params, events),
        "lowlatency" => start_wasapi_mode(params, events, "lowlatency"),
        "exclusive" => start_wasapi_mode(params, events, "exclusive"),
        other => Err(audio_error(format!("unknown output mode {other}"))),
    }
}

#[cfg(windows)]
fn start_wasapi_mode(
    params: &Params,
    events: Sender<String>,
    mode: &str,
) -> Result<AudioHandle, ProtoError> {
    if !params.host.is_empty() && params.host != "wasapi" {
        return Err(audio_error("low-latency modes need the WASAPI driver"));
    }
    let mode = if mode == "exclusive" {
        Mode::Exclusive
    } else {
        Mode::LowLatency
    };
    let shared = Arc::new(Shared::new());
    let stream = wasapi_backend::start(
        &StartConfig {
            device_id: params.output_device.clone(),
            mode,
            sample_rate: params.sample_rate,
            buffer_frames: params.buffer_frames,
        },
        Arc::clone(&shared),
    )?;
    let mut info = stream.info.clone();
    info["deviceId"] = json!(params.output_device);
    info["bufferFramesRequested"] = json!(params.buffer_frames);
    let rate = info["sampleRate"].as_u64().unwrap_or(48000) as u32;
    let stop = Arc::new(AtomicBool::new(false));
    let reporter = spawn_reporter(Arc::clone(&shared), Arc::clone(&stop), events, rate);
    Ok(AudioHandle {
        _stream: Backend::Wasapi(stream),
        shared,
        info,
        stop,
        reporter: Some(reporter),
    })
}

#[cfg(not(windows))]
fn start_wasapi_mode(
    _params: &Params,
    _events: Sender<String>,
    _mode: &str,
) -> Result<AudioHandle, ProtoError> {
    Err(audio_error(
        "low-latency output modes are only available on Windows",
    ))
}

fn start_shared(params: &Params, events: Sender<String>) -> Result<AudioHandle, ProtoError> {
    let device_id = if params.output_device.is_empty() {
        None
    } else {
        Some(
            DeviceId::from_str(&params.output_device)
                .map_err(|e| audio_error(format!("bad device id: {e}")))?,
        )
    };
    let host = pick_host(&params.host, device_id.as_ref())?;
    let device = match &device_id {
        Some(id) => host
            .device_by_id(id)
            .ok_or_else(|| audio_error("the selected output device is not connected"))?,
        None => host
            .default_output_device()
            .ok_or_else(|| audio_error("no default output device"))?,
    };
    let default = device
        .default_output_config()
        .map_err(|e| audio_error(e.to_string()))?;
    if default.sample_format() != SampleFormat::F32 {
        return Err(audio_error(format!(
            "output device uses {:?} samples, only f32 is supported",
            default.sample_format()
        )));
    }
    let channels = default.channels();
    let sample_rate = if params.sample_rate == 0 {
        default.sample_rate()
    } else {
        params.sample_rate
    };
    let ranges: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| audio_error(e.to_string()))?
        .collect();
    let rate_ok = ranges
        .iter()
        .any(|r| r.min_sample_rate() <= sample_rate && sample_rate <= r.max_sample_rate());
    if !rate_ok {
        return Err(audio_error(format!(
            "the device does not support {sample_rate} Hz"
        )));
    }
    let buffer_size = if params.buffer_frames == 0 {
        BufferSize::Default
    } else {
        BufferSize::Fixed(params.buffer_frames)
    };
    let config = StreamConfig {
        channels,
        sample_rate,
        buffer_size,
    };

    let shared = Arc::new(Shared::new());
    let mut renderer = Renderer::with_builtin(sample_rate, usize::from(channels));
    let cb_shared = Arc::clone(&shared);
    let err_tx = events.clone();
    let stream = device
        .build_output_stream::<f32, _, _>(
            config,
            move |data: &mut [f32], info: &OutputCallbackInfo| {
                renderer.apply(&cb_shared.controls);
                let started = renderer.render(data);
                let frames = (data.len() / usize::from(channels)) as u32;
                cb_shared.note_callback(frames);
                if let Some(id) = started {
                    let ts = info.timestamp();
                    let playback = ts.playback.saturating_duration_since(ts.callback);
                    cb_shared.report_click(id, now_us(), playback.as_nanos() as u64, frames);
                }
            },
            move |error| {
                let _ = err_tx.send(event_frame(
                    "audio_error",
                    json!({ "message": error.to_string() }),
                ));
            },
            None,
        )
        .map_err(|e| audio_error(e.to_string()))?;
    stream.play().map_err(|e| audio_error(e.to_string()))?;

    let name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| device.to_string());
    let buffer_range = ranges.iter().find_map(|r| match r.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => Some(json!({ "min": min, "max": max })),
        cpal::SupportedBufferSize::Unknown => None,
    });
    let info = json!({
        "device": name,
        "deviceId": device.id().map(|i| i.to_string()).unwrap_or_default(),
        "sampleRate": sample_rate,
        "channels": channels,
        "bufferFramesRequested": params.buffer_frames,
        "bufferRange": buffer_range,
        "mode": "shared",
        "bufferFrames": params.buffer_frames,
        "periodMs": Value::Null,
        "streamLatencyMs": Value::Null,
        "format": "Float32 (cpal shared)",
    });

    let stop = Arc::new(AtomicBool::new(false));
    let reporter = spawn_reporter(Arc::clone(&shared), Arc::clone(&stop), events, sample_rate);
    Ok(AudioHandle {
        _stream: Backend::Cpal(stream),
        shared,
        info,
        stop,
        reporter: Some(reporter),
    })
}

fn spawn_reporter(
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    events: Sender<String>,
    sample_rate: u32,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut seen = 0u64;
        while !stop.load(Ordering::Acquire) {
            let seq = shared.report_seq.load(Ordering::Acquire);
            if seq != seen {
                seen = seq;
                let frame = event_frame(
                    "click_report",
                    json!({
                        "id": seq,
                        "engineRecvUs": shared.recv_us[(seq as usize) % SLOTS].load(Ordering::Acquire),
                        "callbackUs": shared.report_callback_us.load(Ordering::Relaxed),
                        "playbackNs": shared.report_playback_ns.load(Ordering::Relaxed),
                        "bufferFrames": shared.report_frames.load(Ordering::Relaxed),
                        "sampleRate": sample_rate,
                    }),
                );
                if events.send(frame).is_err() {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(1));
        }
    })
}
