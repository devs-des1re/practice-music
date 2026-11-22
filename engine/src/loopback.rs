use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, DeviceId, InputCallbackInfo, SampleFormat, StreamConfig};
use serde_json::{Value, json};

use crate::audio::{AudioHandle, now_us};
use crate::protocol::ProtoError;

const MARKS: usize = 4096;

struct Capture {
    samples: Box<[AtomicU32]>,
    written: AtomicUsize,
    mark_pos: Box<[AtomicU64]>,
    mark_wall: Box<[AtomicU64]>,
    marks: AtomicUsize,
}

impl Capture {
    fn new(frames: usize) -> Self {
        Self {
            samples: (0..frames).map(|_| AtomicU32::new(0)).collect(),
            written: AtomicUsize::new(0),
            mark_pos: (0..MARKS).map(|_| AtomicU64::new(0)).collect(),
            mark_wall: (0..MARKS).map(|_| AtomicU64::new(0)).collect(),
            marks: AtomicUsize::new(0),
        }
    }

    fn push_block(&self, first_frame_wall_us: u64, block: impl Iterator<Item = f32>) {
        let start = self.written.load(Ordering::Relaxed);
        let mark = self.marks.load(Ordering::Relaxed);
        self.mark_pos[mark % MARKS].store(start as u64, Ordering::Relaxed);
        self.mark_wall[mark % MARKS].store(first_frame_wall_us, Ordering::Relaxed);
        let mut pos = start;
        for sample in block {
            self.samples[pos % self.samples.len()].store(sample.to_bits(), Ordering::Relaxed);
            pos += 1;
        }
        self.written.store(pos, Ordering::Release);
        self.marks.store(mark + 1, Ordering::Release);
    }

    fn wall_of(&self, frame: usize, rate: f64) -> Option<f64> {
        let marks = self.marks.load(Ordering::Acquire);
        let lowest = marks.saturating_sub(MARKS);
        for m in (lowest..marks).rev() {
            let pos = self.mark_pos[m % MARKS].load(Ordering::Relaxed) as usize;
            if pos <= frame {
                let wall = self.mark_wall[m % MARKS].load(Ordering::Relaxed) as f64;
                return Some(wall + (frame - pos) as f64 / rate * 1e6);
            }
        }
        None
    }

    fn sample(&self, frame: usize) -> f32 {
        f32::from_bits(self.samples[frame % self.samples.len()].load(Ordering::Relaxed))
    }
}

fn err(message: impl Into<String>) -> ProtoError {
    ProtoError::new("loopback_error", message)
}

pub struct Probe {
    pub input_device: String,
    pub host: String,
    pub count: usize,
    pub volume: f32,
}

pub fn measure(audio: &AudioHandle, probe: &Probe) -> Result<Value, ProtoError> {
    let device_id = if probe.input_device.is_empty() {
        None
    } else {
        Some(
            DeviceId::from_str(&probe.input_device)
                .map_err(|e| err(format!("bad device id: {e}")))?,
        )
    };
    let host = match &device_id {
        Some(id) => cpal::host_from_id(id.host()).map_err(|e| err(e.to_string()))?,
        None if probe.host.is_empty() => cpal::default_host(),
        None => {
            let found = cpal::available_hosts()
                .into_iter()
                .find(|h| h.to_string() == probe.host)
                .ok_or_else(|| err("audio driver is not available"))?;
            cpal::host_from_id(found).map_err(|e| err(e.to_string()))?
        }
    };
    let device = match &device_id {
        Some(id) => host
            .device_by_id(id)
            .ok_or_else(|| err("the input device is not connected"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| err("no default input device"))?,
    };
    let default = device
        .default_input_config()
        .map_err(|e| err(e.to_string()))?;
    if default.sample_format() != SampleFormat::F32 {
        return Err(err("input device does not provide f32 samples"));
    }
    let channels = usize::from(default.channels());
    let rate = default.sample_rate();
    let config = StreamConfig {
        channels: default.channels(),
        sample_rate: rate,
        buffer_size: BufferSize::Default,
    };
    let capture = Arc::new(Capture::new(rate as usize * 8));
    let cb_capture = Arc::clone(&capture);
    let stream = device
        .build_input_stream::<f32, _, _>(
            config,
            move |data: &[f32], info: &InputCallbackInfo| {
                let ts = info.timestamp();
                let age = ts.callback.saturating_duration_since(ts.capture);
                let wall = now_us().saturating_sub(age.as_micros() as u64);
                cb_capture.push_block(wall, data.iter().step_by(channels).copied());
            },
            |_| {},
            None,
        )
        .map_err(|e| err(e.to_string()))?;
    stream.play().map_err(|e| err(e.to_string()))?;

    let controls = &audio.shared.controls;
    let previous_volume = controls.volume();
    controls.set_volume(probe.volume);
    let result = run_probe(audio, &capture, rate, probe.count);
    controls.set_volume(previous_volume);
    drop(stream);
    result
}

fn run_probe(
    audio: &AudioHandle,
    capture: &Capture,
    rate: u32,
    count: usize,
) -> Result<Value, ProtoError> {
    let rate_f = f64::from(rate);
    thread::sleep(Duration::from_millis(500));
    let settled = capture.written.load(Ordering::Acquire);
    if settled < rate as usize / 4 {
        return Err(err("the input device delivered no audio"));
    }
    let noise_end = settled;
    let noise_start = noise_end.saturating_sub(rate as usize / 3);
    let noise_peak = (noise_start..noise_end)
        .map(|i| capture.sample(i).abs())
        .fold(0.0f32, f32::max);
    let threshold = (noise_peak * 6.0).max(0.004);

    let mut round_trips = Vec::new();
    let mut missed = 0usize;
    for _ in 0..count {
        let started_at = capture.written.load(Ordering::Acquire);
        let id = audio.shared.trigger(now_us());
        let report = wait_report(audio, id)
            .ok_or_else(|| err("the output stream never played the click"))?;
        thread::sleep(Duration::from_millis(450));
        let end = capture.written.load(Ordering::Acquire);
        let mut onset = None;
        for frame in started_at..end {
            if capture.sample(frame).abs() > threshold
                && let Some(wall) = capture.wall_of(frame, rate_f)
                && wall >= report.callback_us as f64 - 20_000.0
            {
                onset = Some(wall);
                break;
            }
        }
        match onset {
            Some(wall) => round_trips.push((wall - report.callback_us as f64) / 1000.0),
            None => missed += 1,
        }
        thread::sleep(Duration::from_millis(150));
    }
    round_trips.sort_by(|a, b| a.total_cmp(b));
    let median = round_trips.get(round_trips.len() / 2).copied();
    Ok(json!({
        "detected": round_trips.len(),
        "missed": missed,
        "noisePeak": noise_peak,
        "threshold": threshold,
        "roundTripMs": round_trips,
        "medianMs": median,
        "minMs": round_trips.first(),
        "maxMs": round_trips.last(),
        "inputSampleRate": rate,
    }))
}

struct Seen {
    callback_us: u64,
}

fn wait_report(audio: &AudioHandle, id: u64) -> Option<Seen> {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Some(callback_us) = audio.shared.reported_callback_us(id) {
            return Some(Seen { callback_us });
        }
        thread::sleep(Duration::from_millis(1));
    }
    None
}
