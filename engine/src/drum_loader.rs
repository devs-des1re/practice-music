use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::decode;
use crate::drums::{Hub, Kit, Layer, MAX_PADS, Sample, Sound};
use crate::protocol::event_frame;

const MAX_SECONDS: usize = 8;
const ONSET_LEVEL: f32 = 0.01;
const TAIL_LEVEL: f32 = 0.0006;
const PRE_ROLL: usize = 24;
const FADE_FRAMES: usize = 960;
const SAME_LAYER_DB: f32 = 1.5;
const MAX_WORKERS: usize = 6;
const SWITCH_TIME: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Deserialize)]
pub struct Mic {
    pub path: String,
    pub left: f32,
    pub right: f32,
}

pub type Take = Vec<Mic>;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PadSource {
    #[serde(default)]
    pub layers: Vec<Vec<Take>>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub pads: Vec<PadSource>,
}

pub fn take_key(take: &Take, rate: u32) -> String {
    let mut key = rate.to_string();
    for mic in take {
        key.push_str(&format!("|{}*{:.3},{:.3}", mic.path, mic.left, mic.right));
    }
    key
}

pub fn trim(mut frames: Vec<f32>) -> Vec<f32> {
    let peak = frames.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak <= 0.0 {
        return Vec::new();
    }
    let loud = |pair: &[f32], level: f32| pair[0].abs() > level || pair[1].abs() > level;
    let start = frames
        .as_chunks::<2>()
        .0
        .iter()
        .position(|p| loud(p, peak * ONSET_LEVEL))
        .unwrap_or(0)
        .saturating_sub(PRE_ROLL);
    let end = frames
        .as_chunks::<2>()
        .0
        .iter()
        .rposition(|p| loud(p, TAIL_LEVEL))
        .map_or(0, |i| i + 1);
    if end <= start {
        return Vec::new();
    }
    frames.truncate(end * 2);
    frames.drain(..start * 2);
    frames
}

pub fn pack(mut frames: Vec<f32>, max_frames: usize) -> Sample {
    if frames.len() > max_frames * 2 {
        frames.truncate(max_frames * 2);
    }
    let count = frames.len() / 2;
    let fade = FADE_FRAMES.min(count);
    for i in 0..fade {
        let gain = i as f32 / fade as f32;
        let at = count - 1 - i;
        frames[at * 2] *= gain;
        frames[at * 2 + 1] *= gain;
    }
    let peak = frames.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let scale = if peak > 0.0 { peak / 32767.0 } else { 0.0 };
    let data = frames
        .iter()
        .map(|v| {
            if scale > 0.0 {
                (v / scale).round() as i16
            } else {
                0
            }
        })
        .collect::<Vec<_>>()
        .into_boxed_slice();
    Sample { data, scale }
}

fn decoded(path: &str, rate: u32) -> Result<Vec<f32>, String> {
    let native = decode::decode_file(path).map_err(|e| format!("{path}: {e}"))?;
    Ok(decode::resample(&native, rate).frames)
}

pub fn mix_take(take: &Take, rate: u32) -> Result<Sample, String> {
    let mut mixed: Vec<f32> = Vec::new();
    for mic in take {
        let frames = decoded(&mic.path, rate)?;
        if frames.len() > mixed.len() {
            mixed.resize(frames.len(), 0.0);
        }
        for (i, pair) in frames.as_chunks::<2>().0.iter().enumerate() {
            mixed[i * 2] += pair[0] * mic.left;
            mixed[i * 2 + 1] += pair[1] * mic.right;
        }
    }
    Ok(pack(trim(mixed), MAX_SECONDS * rate as usize))
}

pub fn peak_db(sample: &Sample) -> f32 {
    let peak = sample
        .data
        .iter()
        .map(|v| i32::from(*v).abs())
        .max()
        .unwrap_or(0) as f32
        * sample.scale;
    if peak > 0.0 {
        20.0 * peak.log10()
    } else {
        -120.0
    }
}

pub fn layers_by_loudness(mut samples: Vec<Arc<Sample>>) -> Vec<Layer> {
    samples.sort_by(|a, b| peak_db(a).total_cmp(&peak_db(b)));
    let mut layers: Vec<Layer> = Vec::new();
    let mut floor = f32::NEG_INFINITY;
    for sample in samples {
        let level = peak_db(&sample);
        match layers.last_mut() {
            Some(layer) if level - floor <= SAME_LAYER_DB => layer.takes.push(sample),
            _ => {
                floor = level;
                layers.push(Layer {
                    takes: vec![sample],
                });
            }
        }
    }
    layers
}

#[derive(Default)]
pub struct Loader {
    generation: Arc<AtomicU64>,
    cache: Arc<Mutex<HashMap<String, Arc<Sample>>>>,
}

fn jobs(request: &Request, rate: u32) -> Vec<(String, Take)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for pad in request.pads.iter().take(MAX_PADS) {
        let own = pad.files.iter().map(|path| {
            vec![Mic {
                path: path.clone(),
                left: 1.0,
                right: 1.0,
            }]
        });
        for take in pad.layers.iter().flatten().cloned().chain(own) {
            let key = take_key(&take, rate);
            if seen.insert(key.clone()) {
                out.push((key, take));
            }
        }
    }
    out
}

pub fn assemble(request: &Request, rate: u32, samples: &HashMap<String, Arc<Sample>>) -> Kit {
    let pads = request
        .pads
        .iter()
        .take(MAX_PADS)
        .map(|pad| {
            let find = |take: &Take| samples.get(&take_key(take, rate)).cloned();
            if !pad.files.is_empty() {
                let own = pad
                    .files
                    .iter()
                    .filter_map(|path| {
                        find(&vec![Mic {
                            path: path.clone(),
                            left: 1.0,
                            right: 1.0,
                        }])
                    })
                    .collect();
                return Sound {
                    layers: layers_by_loudness(own),
                };
            }
            Sound {
                layers: pad
                    .layers
                    .iter()
                    .map(|takes| Layer {
                        takes: takes.iter().filter_map(find).collect(),
                    })
                    .filter(|layer| !layer.takes.is_empty())
                    .collect(),
            }
        })
        .collect();
    Kit { rate, pads }
}

impl Loader {
    pub fn start(
        &self,
        request: Request,
        rate: u32,
        token: u64,
        hub: Arc<Hub>,
        events: Sender<String>,
    ) {
        let generation = Arc::clone(&self.generation);
        let cache = Arc::clone(&self.cache);
        let mine = generation.fetch_add(1, Ordering::AcqRel) + 1;
        thread::spawn(move || {
            let report = |state: &str, done: usize, total: usize, bytes: usize, error: &str| {
                let _ = events.send(event_frame(
                    "drum_kit",
                    json!({ "token": token, "state": state, "done": done, "total": total, "bytes": bytes, "error": error }),
                ));
            };
            let all = jobs(&request, rate);
            let total = all.len();
            let mut ready: HashMap<String, Arc<Sample>> = HashMap::new();
            let mut missing = Vec::new();
            if let Ok(kept) = cache.lock() {
                for (key, take) in all {
                    match kept.get(&key) {
                        Some(sample) => {
                            ready.insert(key, Arc::clone(sample));
                        }
                        None => missing.push((key, take)),
                    }
                }
            }
            let next = AtomicUsize::new(0);
            let done = AtomicUsize::new(ready.len());
            let found = Mutex::new(Vec::new());
            let failure: Mutex<Option<String>> = Mutex::new(None);
            let workers = thread::available_parallelism()
                .map_or(2, |n| n.get().saturating_sub(1))
                .clamp(1, MAX_WORKERS);
            report("loading", done.load(Ordering::Relaxed), total, 0, "");
            thread::scope(|scope| {
                for _ in 0..workers {
                    scope.spawn(|| {
                        loop {
                            if generation.load(Ordering::Acquire) != mine {
                                return;
                            }
                            let Some((key, take)) =
                                missing.get(next.fetch_add(1, Ordering::AcqRel))
                            else {
                                return;
                            };
                            match mix_take(take, rate) {
                                Ok(sample) => {
                                    if let Ok(mut list) = found.lock() {
                                        list.push((key.clone(), Arc::new(sample)));
                                    }
                                }
                                Err(message) => {
                                    if let Ok(mut slot) = failure.lock() {
                                        slot.get_or_insert(message);
                                    }
                                }
                            }
                            done.fetch_add(1, Ordering::AcqRel);
                        }
                    });
                }
                while done.load(Ordering::Acquire) < total
                    && generation.load(Ordering::Acquire) == mine
                {
                    thread::sleep(Duration::from_millis(150));
                    report("loading", done.load(Ordering::Acquire), total, 0, "");
                }
            });
            if generation.load(Ordering::Acquire) != mine {
                return;
            }
            if let Some(message) = failure.into_inner().ok().flatten() {
                report("failed", done.load(Ordering::Acquire), total, 0, &message);
                return;
            }
            ready.extend(found.into_inner().unwrap_or_default());
            let kit = assemble(&request, rate, &ready);
            let bytes = kit.bytes();
            if let Ok(mut kept) = cache.lock() {
                *kept = ready;
            }
            hub.set_kit(Arc::new(kit));
            report("ready", total, total, bytes, "");
            thread::sleep(SWITCH_TIME);
            hub.release_retired_kit();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(path: &std::path::Path, rate: u32, samples: &[i16]) {
        let bytes = samples.len() as u32 * 2;
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + bytes).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&rate.to_le_bytes());
        data.extend_from_slice(&(rate * 2).to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&bytes.to_le_bytes());
        for s in samples {
            data.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, data).unwrap();
    }

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-drums-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn silence_before_the_hit_is_removed_so_it_does_not_add_delay() {
        let mut frames = vec![0.0f32; 4800 * 2];
        for i in 2400..2500 {
            frames[i * 2] = 0.5;
        }
        let out = trim(frames);
        assert_eq!(out.len() / 2, 100 + PRE_ROLL);
        assert_eq!(out[PRE_ROLL * 2], 0.5);
        assert!(trim(vec![0.0; 100]).is_empty());
    }

    #[test]
    fn packing_keeps_the_level_and_ends_quietly() {
        let sample = pack(vec![0.25; 4000 * 2], 3000);
        assert_eq!(sample.frames(), 3000);
        let first = f32::from(sample.data[0]) * sample.scale;
        assert!((first - 0.25).abs() < 1e-3);
        assert_eq!(sample.data[sample.data.len() - 1], 0);
    }

    #[test]
    fn microphones_are_mixed_into_one_stereo_sound() {
        let dir = folder("mix");
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        wav(&a, 48000, &[16384; 3000]);
        wav(&b, 48000, &[8192; 3000]);
        let take = vec![
            Mic {
                path: a.to_string_lossy().into_owned(),
                left: 1.0,
                right: 0.0,
            },
            Mic {
                path: b.to_string_lossy().into_owned(),
                left: 0.5,
                right: 1.0,
            },
        ];
        let sample = mix_take(&take, 48000).unwrap();
        let at = |i: usize| f32::from(sample.data[i]) * sample.scale;
        assert!(
            (at(0) - 0.625).abs() < 0.01 && (at(1) - 0.25).abs() < 0.01,
            "{} {}",
            at(0),
            at(1)
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn own_files_are_layered_from_soft_to_hard_with_similar_ones_alternating() {
        let make = |level: f32| Arc::new(pack(vec![level; 2000], 2000));
        let layers = layers_by_loudness(vec![make(0.8), make(0.1), make(0.75), make(0.4)]);
        assert_eq!(
            layers.iter().map(|l| l.takes.len()).collect::<Vec<_>>(),
            vec![1, 1, 2]
        );
        assert!(peak_db(&layers[0].takes[0]) < peak_db(&layers[1].takes[0]));
    }

    #[test]
    fn a_kit_request_loads_in_the_background_and_reports_when_ready() {
        let dir = folder("load");
        let path = dir.join("hit.wav");
        wav(&path, 44100, &[12000; 4410]);
        let hub = Arc::new(Hub::default());
        let (drum_tx, drum_rx) = std::sync::mpsc::channel();
        hub.attach(drum_tx, 48000);
        let (tx, rx) = std::sync::mpsc::channel();
        let request = Request {
            pads: vec![
                PadSource {
                    files: vec![path.to_string_lossy().into_owned()],
                    ..PadSource::default()
                },
                PadSource::default(),
            ],
        };
        Loader::default().start(request, 48000, 7, Arc::clone(&hub), tx);
        let last = loop {
            let frame = rx.recv_timeout(Duration::from_secs(10)).expect("a report");
            let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if value["data"]["state"] != "loading" {
                break value;
            }
        };
        assert_eq!(last["data"]["state"], "ready", "{last}");
        assert_eq!(last["data"]["token"], 7);
        match drum_rx.try_recv() {
            Ok(crate::drums::DrumCommand::Kit(kit)) => {
                assert_eq!(kit.pads.len(), 2);
                assert_eq!(kit.pads[0].layers.len(), 1);
                assert!(kit.pads[1].layers.is_empty());
                let frames = kit.pads[0].layers[0].takes[0].frames();
                assert!((4700..=4900).contains(&frames), "{frames}");
            }
            _ => panic!("no kit was sent to the audio stream"),
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_missing_file_fails_the_load_with_its_name() {
        let hub = Arc::new(Hub::default());
        let (tx, rx) = std::sync::mpsc::channel();
        let request = Request {
            pads: vec![PadSource {
                files: vec!["Z:/nope/missing.wav".to_string()],
                ..PadSource::default()
            }],
        };
        Loader::default().start(request, 48000, 1, hub, tx);
        loop {
            let frame = rx.recv_timeout(Duration::from_secs(10)).expect("a report");
            let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if value["data"]["state"] == "failed" {
                assert!(
                    value["data"]["error"]
                        .as_str()
                        .unwrap()
                        .contains("missing.wav")
                );
                break;
            }
            assert_eq!(value["data"]["state"], "loading");
        }
    }
}
