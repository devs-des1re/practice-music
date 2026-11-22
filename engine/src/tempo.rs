pub struct Grid {
    pub bpm: f64,
    pub offset_ms: f64,
    pub beats_per_bar: u32,
    pub downbeat: u32,
    pub confidence: f64,
}

const TARGET_RATE: f64 = 11025.0;
const HOP: usize = 128;
const MIN_BPM: f64 = 70.0;
const MAX_BPM: f64 = 180.0;

fn downmix(frames: &[f32], rate: u32) -> (Vec<f32>, f64) {
    let factor = ((f64::from(rate) / TARGET_RATE).round() as usize).max(1);
    let total = frames.len() / 2;
    let n = total / factor;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut sum = 0.0f32;
        for k in 0..factor {
            let f = i * factor + k;
            sum += 0.5 * (frames[f * 2] + frames[f * 2 + 1]);
        }
        out.push(sum / factor as f32);
    }
    (out, f64::from(rate) / factor as f64)
}

fn onset_envelope(signal: &[f32]) -> Vec<f32> {
    let frames = signal.len() / HOP;
    let mut energy = Vec::with_capacity(frames);
    let mut prev = 0.0f32;
    for f in 0..frames {
        let mut e = 0.0f32;
        for i in 0..HOP {
            let idx = f * HOP + i;
            let d = signal[idx] - if idx > 0 { signal[idx - 1] } else { 0.0 };
            e += d * d;
        }
        let _ = prev;
        prev = e;
        energy.push((1.0 + 1000.0 * e / HOP as f32).ln());
    }
    let mut env = vec![0.0f32; frames];
    for f in 1..frames {
        env[f] = (energy[f] - energy[f - 1]).max(0.0);
    }
    let mean = env.iter().sum::<f32>() / env.len().max(1) as f32;
    for v in env.iter_mut() {
        *v = (*v - mean * 0.5).max(0.0);
    }
    env
}

fn interp(env: &[f32], pos: f64) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    let i = pos.floor() as usize;
    if i + 1 >= env.len() {
        return 0.0;
    }
    let t = (pos - i as f64) as f32;
    env[i] * (1.0 - t) + env[i + 1] * t
}

fn comb(env: &[f32], period: f64, phase: f64) -> f32 {
    let mut sum = 0.0f32;
    let mut pos = phase;
    while pos < env.len() as f64 - 1.0 {
        sum += interp(env, pos);
        pos += period;
    }
    sum
}

pub fn detect(frames: &[f32], rate: u32) -> Option<Grid> {
    let (mono, eff_rate) = downmix(frames, rate);
    if mono.len() < (eff_rate * 6.0) as usize {
        return None;
    }
    let env = onset_envelope(&mono);
    let frame_rate = eff_rate / HOP as f64;
    let min_lag = (frame_rate * 60.0 / MAX_BPM).floor() as usize;
    let max_lag = ((frame_rate * 60.0 / MIN_BPM).ceil() as usize).min(env.len() / 2);
    if max_lag <= min_lag + 2 {
        return None;
    }
    let mut best_lag = 0usize;
    let mut best_score = f64::MIN;
    let mut acf = vec![0.0f64; max_lag + 2];
    for lag in min_lag..=max_lag + 1 {
        let mut sum = 0.0f64;
        let n = env.len() - lag;
        for i in 0..n {
            sum += f64::from(env[i]) * f64::from(env[i + lag]);
        }
        acf[lag.min(max_lag + 1)] = sum / n as f64;
    }
    for lag in min_lag..=max_lag {
        let bpm = frame_rate * 60.0 / lag as f64;
        let octave = (bpm / 120.0).log2();
        let prior = (-(octave * octave) / (2.0 * 0.7 * 0.7)).exp();
        let double = if lag * 2 <= max_lag + 1 {
            acf[lag * 2]
        } else {
            0.0
        };
        let score = (acf[lag] + 0.5 * double) * prior;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best_score <= 0.0 {
        return None;
    }
    let coarse_bpm = frame_rate * 60.0 / best_lag as f64;

    let mut best = (coarse_bpm, 0.0f64, f32::MIN);
    let mut bpm = coarse_bpm * 0.97;
    while bpm <= coarse_bpm * 1.03 {
        let period = frame_rate * 60.0 / bpm;
        let mut phase = 0.0;
        while phase < period {
            let s = comb(&env, period, phase) / (env.len() as f64 / period) as f32;
            if s > best.2 {
                best = (bpm, phase, s);
            }
            phase += 0.5;
        }
        bpm += 0.05;
    }
    let (bpm, phase, _) = best;
    let period = frame_rate * 60.0 / bpm;

    let beats = ((env.len() as f64 - phase) / period).floor() as usize;
    let mut class = [0.0f32; 4];
    let mut counts = [0usize; 4];
    for k in 0..beats {
        let strength = interp(&env, phase + k as f64 * period);
        class[k % 4] += strength;
        counts[k % 4] += 1;
    }
    let mut downbeat = 0usize;
    let mut top = f32::MIN;
    for c in 0..4 {
        let avg = class[c] / counts[c].max(1) as f32;
        if avg > top {
            top = avg;
            downbeat = c;
        }
    }
    let mean_strength = class.iter().sum::<f32>() / beats.max(1) as f32;
    let overall = env.iter().sum::<f32>() / env.len() as f32;
    let confidence = if overall > 0.0 {
        f64::from((mean_strength / overall).min(10.0)) / 10.0
    } else {
        0.0
    };

    let lead_ms = 0.5 * HOP as f64 / eff_rate * 1000.0;
    let mut offset_ms = phase / frame_rate * 1000.0 - lead_ms;
    let beat_ms = 60000.0 / bpm;
    while offset_ms < 0.0 {
        offset_ms += beat_ms;
    }
    Some(Grid {
        bpm,
        offset_ms,
        beats_per_bar: 4,
        downbeat: downbeat as u32,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn drum_track(rate: u32, bpm: f64, seconds: f64, offset_s: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        let mut out = vec![0.0f32; n * 2];
        let beat = 60.0 / bpm;
        let mut k = 0usize;
        let mut seed = 12345u32;
        loop {
            let t = offset_s + k as f64 * beat;
            if t >= seconds {
                break;
            }
            let start = (t * f64::from(rate)) as usize;
            let accent = if k.is_multiple_of(4) { 1.0 } else { 0.55 };
            let len = (f64::from(rate) * 0.12) as usize;
            for i in 0..len {
                if start + i >= n {
                    break;
                }
                let env = (-(i as f32) / (len as f32 / 5.0)).exp();
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
                let tone = (2.0 * PI * 140.0 * i as f32 / rate as f32).sin();
                let v = accent * env * (0.6 * tone + 0.4 * noise) * 0.7;
                out[(start + i) * 2] += v;
                out[(start + i) * 2 + 1] += v;
            }
            k += 1;
        }
        out
    }

    #[test]
    fn finds_the_tempo_of_steady_drum_patterns() {
        for bpm in [80.0, 100.0, 120.0, 135.0, 150.0] {
            let track = drum_track(44100, bpm, 24.0, 0.3);
            let grid = detect(&track, 44100).expect("a grid");
            assert!(
                (grid.bpm - bpm).abs() < bpm * 0.01,
                "wanted {bpm}, got {}",
                grid.bpm
            );
        }
    }

    #[test]
    fn finds_where_the_first_beat_falls() {
        for (bpm, offset) in [(120.0, 0.3), (100.0, 0.55), (140.0, 0.1)] {
            let track = drum_track(44100, bpm, 24.0, offset);
            let grid = detect(&track, 44100).expect("a grid");
            let beat_ms = 60000.0 / grid.bpm;
            let mut diff = (grid.offset_ms - offset * 1000.0) % beat_ms;
            if diff > beat_ms / 2.0 {
                diff -= beat_ms;
            }
            if diff < -beat_ms / 2.0 {
                diff += beat_ms;
            }
            assert!(
                diff.abs() < 30.0,
                "bpm {bpm}: offset {} vs {}",
                grid.offset_ms,
                offset * 1000.0
            );
        }
    }

    #[test]
    fn finds_the_downbeat_from_the_accents() {
        let track = drum_track(44100, 120.0, 24.0, 0.0);
        let grid = detect(&track, 44100).expect("a grid");
        let beat_ms = 60000.0 / grid.bpm;
        let first_bar_beat = (grid.downbeat as f64 * beat_ms + grid.offset_ms) % (4.0 * beat_ms);
        let wrapped = first_bar_beat.min(4.0 * beat_ms - first_bar_beat);
        assert!(
            wrapped < 40.0,
            "downbeat lands {wrapped} ms from a bar line (downbeat {}, offset {})",
            grid.downbeat,
            grid.offset_ms
        );
    }

    #[test]
    fn works_at_other_sample_rates() {
        let track = drum_track(48000, 110.0, 20.0, 0.2);
        let grid = detect(&track, 48000).expect("a grid");
        assert!((grid.bpm - 110.0).abs() < 1.5, "got {}", grid.bpm);
    }

    #[test]
    fn silence_and_short_clips_give_no_grid() {
        assert!(
            detect(&vec![0.0f32; 44100 * 2 * 20], 44100).is_none()
                || detect(&vec![0.0f32; 44100 * 2 * 20], 44100)
                    .unwrap()
                    .confidence
                    == 0.0
        );
        assert!(detect(&drum_track(44100, 120.0, 2.0, 0.0), 44100).is_none());
    }

    #[test]
    fn a_louder_track_gives_the_same_tempo() {
        let quiet = drum_track(44100, 124.0, 20.0, 0.1);
        let loud: Vec<f32> = quiet.iter().map(|v| v * 3.0).collect();
        let a = detect(&quiet, 44100).unwrap();
        let b = detect(&loud, 44100).unwrap();
        assert!((a.bpm - b.bpm).abs() < 0.2);
    }
}
