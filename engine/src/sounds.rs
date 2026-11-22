use std::f64::consts::PI;

pub const ROLE_ACCENT: usize = 0;
pub const ROLE_BEAT: usize = 1;
pub const ROLE_SUB: usize = 2;
pub const ROLE_POLY: usize = 3;
pub const ROLES: usize = 4;

pub const PRESETS: [&str; 5] = ["click", "wood", "beep", "hat", "cowbell"];

pub fn role_from_name(name: &str) -> Option<usize> {
    match name {
        "accent" => Some(ROLE_ACCENT),
        "beat" => Some(ROLE_BEAT),
        "sub" => Some(ROLE_SUB),
        "poly" => Some(ROLE_POLY),
        _ => None,
    }
}

pub fn builtin_click(rate: u32, freq: f64, peak: f32) -> Box<[f32]> {
    let rate_f = f64::from(rate);
    let length = (rate_f * 0.045) as usize;
    let attack = (rate_f * 0.0005).max(1.0);
    let tau = 0.007;
    (0..length)
        .map(|i| {
            let t = i as f64 / rate_f;
            let ramp = ((i as f64 + 1.0) / attack).min(1.0);
            let env = (-t / tau).exp();
            (ramp * env * (2.0 * PI * freq * t).sin()) as f32 * peak
        })
        .collect()
}

fn tone(rate: u32, seconds: f64, tau: f64, partials: &[(f64, f64)], peak: f32) -> Box<[f32]> {
    let rate_f = f64::from(rate);
    let length = (rate_f * seconds) as usize;
    let attack = (rate_f * 0.0004).max(1.0);
    (0..length)
        .map(|i| {
            let t = i as f64 / rate_f;
            let ramp = ((i as f64 + 1.0) / attack).min(1.0);
            let env = ramp * (-t / tau).exp();
            let sum: f64 = partials
                .iter()
                .map(|(freq, amp)| amp * (2.0 * PI * freq * t).sin())
                .sum();
            (env * sum) as f32 * peak
        })
        .collect()
}

fn beep(rate: u32, freq: f64, peak: f32) -> Box<[f32]> {
    let rate_f = f64::from(rate);
    let length = (rate_f * 0.06) as usize;
    let fade = (rate_f * 0.004) as usize;
    (0..length)
        .map(|i| {
            let t = i as f64 / rate_f;
            let up = (i as f64 / fade as f64).min(1.0);
            let down = ((length - i) as f64 / fade as f64).min(1.0);
            (up * down * (2.0 * PI * freq * t).sin()) as f32 * peak
        })
        .collect()
}

fn noise_burst(rate: u32, seconds: f64, tau: f64, seed: u32, peak: f32) -> Box<[f32]> {
    let rate_f = f64::from(rate);
    let length = (rate_f * seconds) as usize;
    let mut state = seed.max(1);
    let mut previous = 0.0f64;
    (0..length)
        .map(|i| {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            let white = f64::from(state >> 8) / f64::from(1u32 << 24) * 2.0 - 1.0;
            let high = white - previous;
            previous = white;
            let t = i as f64 / rate_f;
            let ramp = ((i as f64 + 1.0) / (rate_f * 0.0003)).min(1.0);
            (ramp * (-t / tau).exp() * high * 0.5) as f32 * peak
        })
        .collect()
}

pub fn preset(name: &str, rate: u32) -> Option<[Box<[f32]>; ROLES]> {
    let tables = match name {
        "click" => [
            builtin_click(rate, 1600.0, 1.0),
            builtin_click(rate, 1000.0, 0.9),
            builtin_click(rate, 1000.0, 0.9),
            builtin_click(rate, 700.0, 0.9),
        ],
        "wood" => [
            tone(rate, 0.09, 0.018, &[(1175.0, 1.0), (2350.0, 0.35)], 0.9),
            tone(rate, 0.09, 0.018, &[(880.0, 1.0), (1760.0, 0.35)], 0.85),
            tone(rate, 0.09, 0.018, &[(880.0, 1.0), (1760.0, 0.35)], 0.85),
            tone(rate, 0.09, 0.02, &[(620.0, 1.0), (1240.0, 0.3)], 0.85),
        ],
        "beep" => [
            beep(rate, 1500.0, 0.8),
            beep(rate, 1000.0, 0.7),
            beep(rate, 1000.0, 0.7),
            beep(rate, 750.0, 0.7),
        ],
        "hat" => [
            noise_burst(rate, 0.08, 0.02, 7, 1.6),
            noise_burst(rate, 0.05, 0.012, 11, 1.4),
            noise_burst(rate, 0.05, 0.012, 11, 1.4),
            noise_burst(rate, 0.07, 0.02, 23, 1.4),
        ],
        "cowbell" => [
            tone(rate, 0.25, 0.07, &[(800.0, 1.0), (1200.0, 0.8), (2100.0, 0.3)], 0.6),
            tone(rate, 0.2, 0.05, &[(540.0, 1.0), (810.0, 0.8), (1500.0, 0.3)], 0.55),
            tone(rate, 0.2, 0.05, &[(540.0, 1.0), (810.0, 0.8), (1500.0, 0.3)], 0.55),
            tone(rate, 0.2, 0.05, &[(420.0, 1.0), (630.0, 0.8), (1200.0, 0.3)], 0.55),
        ],
        _ => return None,
    };
    Some(tables)
}

pub fn from_interleaved(frames: &[f32], channels: usize, rate: u32) -> Box<[f32]> {
    let channels = channels.max(1);
    let max_len = (f64::from(rate) * 3.0) as usize;
    let mut mono: Vec<f32> = frames
        .chunks_exact(channels)
        .take(max_len)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect();
    let peak = mono.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > 0.0 {
        let scale = 0.9 / peak;
        for v in mono.iter_mut() {
            *v *= scale;
        }
    }
    let fade_in = (f64::from(rate) * 0.001) as usize;
    let fade_out = ((f64::from(rate) * 0.01) as usize).min(mono.len());
    let len = mono.len();
    for (i, v) in mono.iter_mut().enumerate().take(fade_in) {
        *v *= i as f32 / fade_in.max(1) as f32;
    }
    for i in 0..fade_out {
        mono[len - 1 - i] *= i as f32 / fade_out.max(1) as f32;
    }
    mono.into_boxed_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak(table: &[f32]) -> f32 {
        table.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn every_preset_has_four_audible_finite_sounds() {
        for name in PRESETS {
            let tables = preset(name, 48000).unwrap_or_else(|| panic!("{name} missing"));
            for (role, table) in tables.iter().enumerate() {
                assert!(table.len() > 500, "{name} role {role} is too short");
                assert!(table.iter().all(|v| v.is_finite()), "{name} role {role}");
                let p = peak(table);
                assert!(p > 0.2 && p <= 1.7, "{name} role {role} peak {p}");
            }
        }
    }

    #[test]
    fn presets_decay_to_near_silence() {
        for name in PRESETS {
            let tables = preset(name, 48000).unwrap();
            for table in tables.iter() {
                let tail = peak(&table[table.len() - 20..]);
                assert!(tail < 0.2, "{name} tail {tail}");
            }
        }
    }

    #[test]
    fn unknown_presets_are_refused() {
        assert!(preset("kazoo", 48000).is_none());
    }

    #[test]
    fn role_names_map_to_slots() {
        assert_eq!(role_from_name("accent"), Some(ROLE_ACCENT));
        assert_eq!(role_from_name("poly"), Some(ROLE_POLY));
        assert_eq!(role_from_name("other"), None);
    }

    #[test]
    fn custom_samples_are_mixed_to_mono_normalised_and_faded() {
        let frames: Vec<f32> = (0..4800).flat_map(|i| {
            let v = if i % 2 == 0 { 0.3 } else { -0.3 };
            [v, v]
        }).collect();
        let table = from_interleaved(&frames, 2, 48000);
        assert_eq!(table.len(), 4800);
        assert!((peak(&table) - 0.9).abs() < 0.01);
        assert!(table[0].abs() < 1e-6);
        assert!(table[table.len() - 1].abs() < 0.01);
    }

    #[test]
    fn long_custom_samples_are_trimmed_to_three_seconds() {
        let frames = vec![0.5f32; 48000 * 5 * 2];
        let table = from_interleaved(&frames, 2, 48000);
        assert_eq!(table.len(), 48000 * 3);
    }

    #[test]
    fn silent_samples_stay_silent() {
        let table = from_interleaved(&vec![0.0f32; 400], 2, 48000);
        assert!(table.iter().all(|v| *v == 0.0));
    }
}
