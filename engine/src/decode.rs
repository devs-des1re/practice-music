use std::f64::consts::PI;
use std::fs::File;
use std::path::Path;

use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::TrackType;
use symphonia::core::formats::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

#[derive(Debug)]
pub struct Track {
    pub rate: u32,
    pub frames: Vec<f32>,
}

impl Track {
    pub fn len_frames(&self) -> usize {
        self.frames.len() / 2
    }
}

pub fn decode_file(path: &str) -> Result<Track, String> {
    let file = File::open(path).map_err(|e| format!("cannot open the file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported file: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("the file has no audio track")?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("the audio track has no codec parameters")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;
    let track_id = track.id;

    let mut frames: Vec<f32> = Vec::new();
    let mut rate = 0u32;
    let mut scratch: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::ResetRequired) => break,
            Err(e) => {
                if frames.is_empty() {
                    return Err(format!("could not read the file: {e}"));
                }
                break;
            }
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let channels = buf.spec().channels().count().max(1);
                rate = buf.spec().rate();
                scratch.resize(buf.samples_interleaved(), f32::MID);
                buf.copy_to_slice_interleaved(&mut scratch);
                for frame in scratch.chunks_exact(channels) {
                    let left = frame[0];
                    let right = if channels > 1 { frame[1] } else { frame[0] };
                    frames.push(left);
                    frames.push(right);
                }
            }
            Err(Error::DecodeError(_)) => continue,
            Err(Error::IoError(_)) => continue,
            Err(e) => {
                if frames.is_empty() {
                    return Err(format!("could not decode the file: {e}"));
                }
                break;
            }
        }
    }
    if frames.is_empty() || rate == 0 {
        return Err("the file contains no audio".to_string());
    }
    Ok(Track { rate, frames })
}

const ZEROS: usize = 12;
const PHASES: usize = 1024;

pub fn resample(track: &Track, to: u32) -> Track {
    if track.rate == to {
        return Track {
            rate: to,
            frames: track.frames.clone(),
        };
    }
    let ratio = f64::from(track.rate) / f64::from(to);
    let cutoff = (1.0 / ratio).min(1.0);
    let taps = ZEROS * 2;
    let mut table = vec![0.0f32; PHASES * taps];
    for phase in 0..PHASES {
        let frac = phase as f64 / PHASES as f64;
        let mut sum = 0.0;
        for k in 0..taps {
            let x = (k as f64 - (ZEROS as f64 - 1.0)) - frac;
            let arg = PI * x * cutoff;
            let sinc = if arg.abs() < 1e-9 {
                1.0
            } else {
                arg.sin() / arg
            };
            let w = x / ZEROS as f64;
            let window = if w.abs() >= 1.0 {
                0.0
            } else {
                0.42 + 0.5 * (PI * w).cos() + 0.08 * (2.0 * PI * w).cos()
            };
            let v = sinc * cutoff * window;
            table[phase * taps + k] = v as f32;
            sum += v;
        }
        if sum.abs() > 1e-9 {
            for k in 0..taps {
                table[phase * taps + k] /= sum as f32;
            }
        }
    }
    let in_frames = track.len_frames();
    let out_frames = ((in_frames as f64) / ratio).floor() as usize;
    let mut out = vec![0.0f32; out_frames * 2];
    for n in 0..out_frames {
        let t = n as f64 * ratio;
        let base = t.floor() as isize;
        let phase = (((t - base as f64) * PHASES as f64) as usize).min(PHASES - 1);
        let row = &table[phase * taps..(phase + 1) * taps];
        let start = base - (ZEROS as isize - 1);
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for (k, w) in row.iter().enumerate() {
            let idx = start + k as isize;
            if idx < 0 || idx as usize >= in_frames {
                continue;
            }
            let i = idx as usize * 2;
            l += track.frames[i] * w;
            r += track.frames[i + 1] * w;
        }
        out[n * 2] = l;
        out[n * 2 + 1] = r;
    }
    Track {
        rate: to,
        frames: out,
    }
}

pub fn peaks(frames: &[f32], buckets: usize) -> Vec<f32> {
    let total = frames.len() / 2;
    if total == 0 || buckets == 0 {
        return Vec::new();
    }
    let buckets = buckets.min(total);
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let from = b * total / buckets;
        let to = ((b + 1) * total / buckets).max(from + 1).min(total);
        let (mut lo, mut hi) = (0.0f32, 0.0f32);
        for i in from..to {
            let v = 0.5 * (frames[i * 2] + frames[i * 2 + 1]);
            lo = lo.min(v);
            hi = hi.max(v);
        }
        out.push(lo);
        out.push(hi);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_wav(path: &Path, rate: u32, channels: u16, samples: &[i16]) {
        let data_len = (samples.len() * 2) as u32;
        let mut f = File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&rate.to_le_bytes()).unwrap();
        f.write_all(&(rate * u32::from(channels) * 2).to_le_bytes())
            .unwrap();
        f.write_all(&(channels * 2).to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        for s in samples {
            f.write_all(&s.to_le_bytes()).unwrap();
        }
    }

    fn tone(rate: u32, freq: f64, seconds: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        (0..n)
            .flat_map(|i| {
                let v = (2.0 * PI * freq * i as f64 / f64::from(rate)).sin() as f32 * 0.5;
                [v, v]
            })
            .collect()
    }

    fn crossings(frames: &[f32], rate: u32) -> f64 {
        let mono: Vec<f32> = frames.chunks(2).map(|f| f[0]).collect();
        let c = mono
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        c as f64 / (mono.len() as f64 / f64::from(rate))
    }

    #[test]
    fn decodes_a_stereo_wav_exactly() {
        let dir = tempdir();
        let path = dir.join("a.wav");
        let samples: Vec<i16> = (0..2000).flat_map(|i| [i as i16, -(i as i16)]).collect();
        write_wav(&path, 44100, 2, &samples);
        let t = decode_file(path.to_str().unwrap()).unwrap();
        assert_eq!(t.rate, 44100);
        assert_eq!(t.len_frames(), 2000);
        assert!((t.frames[2 * 1000] - 1000.0 / 32768.0).abs() < 1e-4);
        assert!((t.frames[2 * 1000 + 1] + 1000.0 / 32768.0).abs() < 1e-4);
    }

    #[test]
    fn mono_files_are_duplicated_to_both_channels() {
        let dir = tempdir();
        let path = dir.join("m.wav");
        let samples: Vec<i16> = (0..500).map(|i| (i * 10) as i16).collect();
        write_wav(&path, 22050, 1, &samples);
        let t = decode_file(path.to_str().unwrap()).unwrap();
        assert_eq!(t.rate, 22050);
        assert_eq!(t.len_frames(), 500);
        assert_eq!(t.frames[2 * 100], t.frames[2 * 100 + 1]);
    }

    #[test]
    fn broken_and_missing_files_give_readable_errors() {
        let dir = tempdir();
        let bad = dir.join("bad.mp3");
        std::fs::write(&bad, b"this is not audio at all").unwrap();
        assert!(decode_file(bad.to_str().unwrap()).is_err());
        assert!(
            decode_file(dir.join("missing.wav").to_str().unwrap())
                .unwrap_err()
                .contains("cannot open")
        );
        let empty = dir.join("empty.wav");
        write_wav(&empty, 44100, 2, &[]);
        assert!(decode_file(empty.to_str().unwrap()).is_err());
    }

    #[test]
    fn resampling_keeps_pitch_level_and_length() {
        let src = Track {
            rate: 44100,
            frames: tone(44100, 1000.0, 2.0),
        };
        let up = resample(&src, 48000);
        assert_eq!(up.rate, 48000);
        assert!((up.len_frames() as f64 - 96000.0).abs() <= 2.0);
        let mid = &up.frames[48000 / 2 * 2..48000 * 2 * 3 / 2];
        assert!((crossings(mid, 48000) - 1000.0).abs() < 15.0);
        let peak = mid.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 0.02, "peak {peak}");
        let down = resample(&src, 22050);
        assert!((down.len_frames() as f64 - 44100.0).abs() <= 2.0);
        assert!((crossings(&down.frames[22050..22050 * 3], 22050) - 1000.0).abs() < 20.0);
    }

    #[test]
    fn resampling_to_the_same_rate_is_a_copy() {
        let src = Track {
            rate: 48000,
            frames: tone(48000, 440.0, 0.2),
        };
        assert_eq!(resample(&src, 48000).frames, src.frames);
    }

    #[test]
    fn downsampling_removes_content_above_the_new_nyquist() {
        let src = Track {
            rate: 48000,
            frames: tone(48000, 15000.0, 1.0),
        };
        let down = resample(&src, 16000);
        let peak = down.frames[2000..]
            .iter()
            .fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak < 0.05, "aliased energy {peak}");
    }

    #[test]
    fn peaks_report_the_extremes_per_bucket() {
        let mut frames = vec![0.0f32; 2000];
        frames[2 * 250] = 0.8;
        frames[2 * 250 + 1] = 0.8;
        frames[2 * 750] = -0.6;
        frames[2 * 750 + 1] = -0.6;
        let p = peaks(&frames, 4);
        assert_eq!(p.len(), 8);
        assert_eq!(p[3], 0.8);
        assert_eq!(p[6], -0.6);
        assert_eq!(p[0], 0.0);
        assert!(peaks(&[], 10).is_empty());
        assert_eq!(peaks(&frames, 5000).len(), 2000);
    }

    fn tempdir() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pm-decode-{}-{}", std::process::id(), nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
