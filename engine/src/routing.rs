use std::str::FromStr;
use std::sync::Arc;
use std::sync::mpsc::Sender;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, DeviceId, InputCallbackInfo, OutputCallbackInfo, SampleFormat, StreamConfig};
use serde_json::{Value, json};

use crate::audio::{AudioHandle, Link, Params, Shared};
use crate::mixer::{MeterSnapshot, mp};
use crate::protocol::event_frame;
use crate::ring::{DriftReader, FrameRing};

pub const MAX_CAPTURE_CHANNELS: usize = 16;
const RING_FRAMES: usize = 16384;
const MONITOR_CHUNK: usize = 8192;

fn level_json(level: &crate::mixer::Level) -> Value {
    let round = |v: f32| (f64::from(v) * 10000.0).round() / 10000.0;
    json!({
        "l": round(level.left),
        "r": round(level.right),
        "clip": level.clip,
        "gr": (f64::from(level.reduction_db) * 10.0).round() / 10.0,
    })
}

pub fn meters_json(snapshot: &MeterSnapshot) -> Value {
    json!({
        "strips": snapshot.strips.iter().map(level_json).collect::<Vec<_>>(),
        "main": level_json(&snapshot.main),
        "monitor": level_json(&snapshot.monitor),
    })
}

pub fn add_pair(data: &mut [f32], channels: usize, bus: &[f32], offset: usize) {
    if channels == 0 {
        return;
    }
    let frames = (data.len() / channels).min(bus.len() / 2);
    if channels == 1 {
        for f in 0..frames {
            data[f] += (bus[f * 2] + bus[f * 2 + 1]) * 0.5;
        }
        return;
    }
    if offset + 2 > channels {
        return;
    }
    for f in 0..frames {
        data[f * channels + offset] += bus[f * 2];
        data[f * channels + offset + 1] += bus[f * 2 + 1];
    }
}

fn host_and_device(device: &str, output: bool) -> Result<(cpal::Device, String), String> {
    let id = DeviceId::from_str(device).map_err(|e| format!("bad device id: {e}"))?;
    let host = cpal::host_from_id(id.host()).map_err(|e| e.to_string())?;
    let found = host
        .device_by_id(&id)
        .ok_or_else(|| "the device is not connected".to_string())?;
    let supported = if output { found.supports_output() } else { found.supports_input() };
    if !supported {
        return Err(format!(
            "the device has no {} side",
            if output { "output" } else { "input" }
        ));
    }
    let name = found
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| found.to_string());
    Ok((found, name))
}

fn pick_rate(ranges: &[cpal::SupportedStreamConfigRange], wanted: u32, fallback: u32) -> u32 {
    let ok = ranges
        .iter()
        .any(|r| r.min_sample_rate() <= wanted && wanted <= r.max_sample_rate());
    if ok { wanted } else { fallback }
}

fn start_capture(
    shared: &Arc<Shared>,
    params: &Params,
    events: Sender<String>,
) -> Result<(cpal::Stream, Value), String> {
    let (device, name) = host_and_device(&params.input_device, false)?;
    let default = device.default_input_config().map_err(|e| e.to_string())?;
    if default.sample_format() != SampleFormat::F32 {
        return Err("the input device does not provide f32 samples".to_string());
    }
    let ranges: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| e.to_string())?
        .collect();
    let rate = pick_rate(&ranges, shared.rate, default.sample_rate());
    let device_channels = usize::from(default.channels());
    let ring_channels = device_channels.min(MAX_CAPTURE_CHANNELS);
    let ring = Arc::new(FrameRing::new(ring_channels, RING_FRAMES));
    let config = StreamConfig {
        channels: default.channels(),
        sample_rate: rate,
        buffer_size: BufferSize::Default,
    };
    let cb_ring = Arc::clone(&ring);
    let mut trimmed: Vec<f32> = Vec::with_capacity(if device_channels > ring_channels {
        MONITOR_CHUNK * ring_channels
    } else {
        0
    });
    let err_tx = events;
    let stream = device
        .build_input_stream::<f32, _, _>(
            config,
            move |data: &[f32], _: &InputCallbackInfo| {
                if device_channels == ring_channels {
                    cb_ring.push(data);
                } else {
                    trimmed.clear();
                    for frame in data.chunks_exact(device_channels) {
                        trimmed.extend_from_slice(&frame[..ring_channels]);
                    }
                    cb_ring.push(&trimmed);
                }
            },
            move |error| {
                let _ = err_tx.send(event_frame(
                    "audio_error",
                    json!({ "message": format!("input: {error}") }),
                ));
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    shared
        .capture
        .set(Link { ring, rate })
        .map_err(|_| "capture was already started".to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((
        stream,
        json!({
            "running": true,
            "device": name,
            "channels": device_channels,
            "sampleRate": rate,
            "error": "",
        }),
    ))
}

fn start_monitor(
    shared: &Arc<Shared>,
    params: &Params,
    events: Sender<String>,
) -> Result<(cpal::Stream, Value), String> {
    let (device, name) = host_and_device(&params.monitor_device, true)?;
    let default = device.default_output_config().map_err(|e| e.to_string())?;
    if default.sample_format() != SampleFormat::F32 {
        return Err("the monitor device does not use f32 samples".to_string());
    }
    let ranges: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| e.to_string())?
        .collect();
    let rate = pick_rate(&ranges, shared.rate, default.sample_rate());
    let channels = usize::from(default.channels());
    let config = StreamConfig {
        channels: default.channels(),
        sample_rate: rate,
        buffer_size: BufferSize::Default,
    };
    let ring = Arc::new(FrameRing::gated(2, RING_FRAMES));
    let cb_ring = Arc::clone(&ring);
    let cb_shared = Arc::clone(shared);
    let mut reader = DriftReader::new(shared.rate, rate);
    let mut scratch = vec![0.0f32; MONITOR_CHUNK * 2];
    let err_tx = events;
    let stream = device
        .build_output_stream::<f32, _, _>(
            config,
            move |data: &mut [f32], _: &OutputCallbackInfo| {
                data.fill(0.0);
                let frames = data.len() / channels;
                let offset = cb_shared.params.master(mp::MONITOR_CHANNEL) as usize;
                let mut done = 0;
                while done < frames {
                    let n = (frames - done).min(MONITOR_CHUNK);
                    reader.read(&cb_ring, &mut scratch[..n * 2]);
                    add_pair(
                        &mut data[done * channels..(done + n) * channels],
                        channels,
                        &scratch[..n * 2],
                        offset,
                    );
                    done += n;
                }
            },
            move |error| {
                let _ = err_tx.send(event_frame(
                    "audio_error",
                    json!({ "message": format!("monitor output: {error}") }),
                ));
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    shared
        .monitor
        .set(Link {
            ring,
            rate: shared.rate,
        })
        .map_err(|_| "the monitor output was already started".to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((
        stream,
        json!({
            "mode": "device",
            "running": true,
            "device": name,
            "channels": channels,
            "sampleRate": rate,
            "rateMismatch": rate != shared.rate,
            "error": "",
        }),
    ))
}

pub fn attach(handle: &mut AudioHandle, params: &Params, events: Sender<String>) {
    let shared = Arc::clone(&handle.shared);
    let mut capture = json!({ "running": false, "device": "", "channels": 0, "sampleRate": 0, "error": "" });
    if !params.input_device.is_empty() {
        match start_capture(&shared, params, events.clone()) {
            Ok((stream, info)) => {
                handle.add_stream(stream);
                capture = info;
            }
            Err(message) => {
                capture["error"] = json!(message);
            }
        }
    }
    let same_device =
        params.monitor_device.is_empty() || params.monitor_device == params.output_device;
    let mut monitor = json!({
        "mode": "main",
        "running": true,
        "device": "",
        "channels": 0,
        "sampleRate": 0,
        "rateMismatch": false,
        "error": "",
    });
    if !same_device {
        match start_monitor(&shared, params, events) {
            Ok((stream, info)) => {
                handle.add_stream(stream);
                monitor = info;
            }
            Err(message) => {
                monitor["running"] = json!(false);
                monitor["mode"] = json!("device");
                monitor["error"] = json!(message);
            }
        }
    }
    handle.info["capture"] = capture;
    handle.info["monitor"] = monitor;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mixer::Level;

    #[test]
    fn a_pair_is_added_at_the_requested_channel_offset() {
        let bus = [0.5f32, -0.5, 0.25, -0.25];
        let mut data = vec![0.0f32; 2 * 4];
        add_pair(&mut data, 4, &bus, 2);
        assert_eq!(data, vec![0.0, 0.0, 0.5, -0.5, 0.0, 0.0, 0.25, -0.25]);
    }

    #[test]
    fn adding_is_additive_so_two_buses_can_share_channels() {
        let bus = [0.5f32, 0.5];
        let mut data = vec![0.1f32, 0.1];
        add_pair(&mut data, 2, &bus, 0);
        assert!((data[0] - 0.6).abs() < 1e-6 && (data[1] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn a_pair_beyond_the_device_channels_is_dropped_not_misrouted() {
        let bus = [0.5f32, 0.5];
        let mut data = vec![0.0f32; 2];
        add_pair(&mut data, 2, &bus, 2);
        assert_eq!(data, vec![0.0, 0.0]);
        let mut wide = vec![0.0f32; 4];
        add_pair(&mut wide, 4, &bus, 4);
        assert_eq!(wide, vec![0.0; 4]);
    }

    #[test]
    fn a_mono_device_gets_the_sum_of_both_sides() {
        let bus = [0.4f32, 0.2];
        let mut data = vec![0.0f32; 1];
        add_pair(&mut data, 1, &bus, 0);
        assert!((data[0] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn meter_json_has_a_level_for_every_strip_and_both_buses() {
        let mut snap = MeterSnapshot::default();
        snap.strips[1] = Level {
            left: 0.5,
            right: 0.25,
            clip: true,
            reduction_db: 3.0,
        };
        let v = meters_json(&snap);
        assert_eq!(v["strips"].as_array().unwrap().len(), 6);
        assert_eq!(v["strips"][1]["l"], 0.5);
        assert_eq!(v["strips"][1]["clip"], true);
        assert_eq!(v["strips"][1]["gr"], 3.0);
        assert!(v["main"].is_object() && v["monitor"].is_object());
    }

    #[test]
    fn a_bad_device_id_is_reported_not_panicked() {
        assert!(host_and_device("not-a-device-id", true).is_err());
    }
}
