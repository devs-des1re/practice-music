use std::f64::consts::PI;

pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

pub fn lin_to_db(lin: f32) -> f32 {
    20.0 * lin.max(1e-9).log10()
}

#[derive(Clone, Copy)]
struct Coeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Coeffs {
    const IDENTITY: Coeffs = Coeffs {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    fn normalised(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    fn low_shelf(rate: f64, freq: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / rate;
        let (sin, cos) = w.sin_cos();
        let beta = 2.0 * a.sqrt() * (sin / 2.0 * 2f64.sqrt());
        Self::normalised(
            a * ((a + 1.0) - (a - 1.0) * cos + beta),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
            a * ((a + 1.0) - (a - 1.0) * cos - beta),
            (a + 1.0) + (a - 1.0) * cos + beta,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos),
            (a + 1.0) + (a - 1.0) * cos - beta,
        )
    }

    fn high_shelf(rate: f64, freq: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / rate;
        let (sin, cos) = w.sin_cos();
        let beta = 2.0 * a.sqrt() * (sin / 2.0 * 2f64.sqrt());
        Self::normalised(
            a * ((a + 1.0) + (a - 1.0) * cos + beta),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - beta),
            (a + 1.0) - (a - 1.0) * cos + beta,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - beta,
        )
    }

    fn peaking(rate: f64, freq: f64, q: f64, gain_db: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / rate;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q);
        Self::normalised(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    c: Coeffs,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn new() -> Self {
        Self {
            c: Coeffs::IDENTITY,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    fn tick(&mut self, x: f64) -> f64 {
        let y = self.c.b0 * x + self.z1;
        self.z1 = self.c.b1 * x - self.c.a1 * y + self.z2;
        self.z2 = self.c.b2 * x - self.c.a2 * y;
        y
    }
}

pub const EQ_LOW_HZ: f64 = 120.0;
pub const EQ_MID_HZ: f64 = 1000.0;
pub const EQ_HIGH_HZ: f64 = 6000.0;
pub const EQ_MID_Q: f64 = 0.9;

pub struct Eq3 {
    rate: f64,
    bands: [[Biquad; 2]; 3],
    gains: [f32; 3],
    active: bool,
}

impl Eq3 {
    pub fn new(rate: u32) -> Self {
        Self {
            rate: f64::from(rate),
            bands: [[Biquad::new(); 2]; 3],
            gains: [0.0; 3],
            active: false,
        }
    }

    pub fn set_gains(&mut self, low: f32, mid: f32, high: f32) {
        let next = [low.clamp(-15.0, 15.0), mid.clamp(-15.0, 15.0), high.clamp(-15.0, 15.0)];
        if next == self.gains {
            return;
        }
        self.gains = next;
        let coeffs = [
            Coeffs::low_shelf(self.rate, EQ_LOW_HZ, f64::from(next[0])),
            Coeffs::peaking(self.rate, EQ_MID_HZ, EQ_MID_Q, f64::from(next[1])),
            Coeffs::high_shelf(self.rate, EQ_HIGH_HZ, f64::from(next[2])),
        ];
        for (band, c) in self.bands.iter_mut().zip(coeffs) {
            for filter in band.iter_mut() {
                filter.c = c;
            }
        }
        let active = next.iter().any(|g| g.abs() > 0.05);
        if self.active && !active {
            for band in self.bands.iter_mut() {
                for filter in band.iter_mut() {
                    filter.reset();
                }
            }
        }
        self.active = active;
    }

    pub fn process_stereo(&mut self, buf: &mut [f32]) {
        if !self.active {
            return;
        }
        for frame in buf.as_chunks_mut::<2>().0.iter_mut() {
            let mut l = f64::from(frame[0]);
            let mut r = f64::from(frame[1]);
            for band in self.bands.iter_mut() {
                l = band[0].tick(l);
                r = band[1].tick(r);
            }
            frame[0] = l as f32;
            frame[1] = r as f32;
        }
    }
}

#[derive(Clone, Copy)]
pub struct CompSettings {
    pub enabled: bool,
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
}

impl Default for CompSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 10.0,
            release_ms: 120.0,
            makeup_db: 0.0,
        }
    }
}

pub struct Compressor {
    rate: f32,
    reduction_db: f32,
}

fn time_coef(ms: f32, rate: f32) -> f32 {
    1.0 - (-1.0 / (ms.max(0.05) * 0.001 * rate)).exp()
}

impl Compressor {
    pub fn new(rate: u32) -> Self {
        Self {
            rate: rate as f32,
            reduction_db: 0.0,
        }
    }

    pub fn process_stereo(&mut self, buf: &mut [f32], s: &CompSettings) -> f32 {
        if !s.enabled {
            if self.reduction_db > 0.0 {
                self.reduction_db = 0.0;
            }
            return 0.0;
        }
        let attack = time_coef(s.attack_ms, self.rate);
        let release = time_coef(s.release_ms, self.rate);
        let slope = 1.0 - 1.0 / s.ratio.clamp(1.0, 20.0);
        let makeup = db_to_lin(s.makeup_db);
        let mut deepest = 0.0f32;
        for frame in buf.as_chunks_mut::<2>().0.iter_mut() {
            let level = frame[0].abs().max(frame[1].abs());
            let over = lin_to_db(level) - s.threshold_db;
            let want = if over > 0.0 { over * slope } else { 0.0 };
            let coef = if want > self.reduction_db { attack } else { release };
            self.reduction_db += (want - self.reduction_db) * coef;
            let gain = db_to_lin(-self.reduction_db) * makeup;
            frame[0] *= gain;
            frame[1] *= gain;
            deepest = deepest.max(self.reduction_db);
        }
        deepest
    }
}

pub struct Limiter {
    gain: f32,
    release: f32,
}

impl Limiter {
    pub fn new(rate: u32) -> Self {
        Self {
            gain: 1.0,
            release: time_coef(80.0, rate as f32),
        }
    }

    pub fn process_stereo(&mut self, buf: &mut [f32], ceiling: f32) -> f32 {
        let mut lowest = 1.0f32;
        for frame in buf.as_chunks_mut::<2>().0.iter_mut() {
            let peak = frame[0].abs().max(frame[1].abs());
            let needed = if peak > ceiling { ceiling / peak } else { 1.0 };
            if needed < self.gain {
                self.gain = needed;
            } else {
                self.gain += (1.0 - self.gain) * self.release;
            }
            frame[0] = (frame[0] * self.gain).clamp(-ceiling, ceiling);
            frame[1] = (frame[1] * self.gain).clamp(-ceiling, ceiling);
            lowest = lowest.min(self.gain);
        }
        -lin_to_db(lowest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48000;

    fn sine(freq: f64, frames: usize, amp: f32) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let v = (2.0 * PI * freq * i as f64 / f64::from(RATE)).sin() as f32 * amp;
                [v, v]
            })
            .collect()
    }

    fn rms_tail(buf: &[f32]) -> f32 {
        let tail = &buf[buf.len() / 2..];
        (tail.iter().map(|v| v * v).sum::<f32>() / tail.len() as f32).sqrt()
    }

    fn gain_db(eq_gains: [f32; 3], freq: f64) -> f32 {
        let mut eq = Eq3::new(RATE);
        eq.set_gains(eq_gains[0], eq_gains[1], eq_gains[2]);
        let mut buf = sine(freq, 48000, 0.1);
        let before = rms_tail(&buf);
        eq.process_stereo(&mut buf);
        lin_to_db(rms_tail(&buf) / before)
    }

    #[test]
    fn a_flat_eq_leaves_the_signal_untouched() {
        let mut eq = Eq3::new(RATE);
        eq.set_gains(0.0, 0.0, 0.0);
        let original = sine(440.0, 4800, 0.5);
        let mut buf = original.clone();
        eq.process_stereo(&mut buf);
        assert_eq!(buf, original);
    }

    #[test]
    fn the_low_shelf_boosts_bass_and_leaves_treble_alone() {
        let bass = gain_db([9.0, 0.0, 0.0], 40.0);
        let treble = gain_db([9.0, 0.0, 0.0], 8000.0);
        assert!((bass - 9.0).abs() < 0.6, "bass {bass}");
        assert!(treble.abs() < 0.6, "treble {treble}");
    }

    #[test]
    fn the_mid_band_cuts_around_one_kilohertz_only() {
        let mid = gain_db([0.0, -9.0, 0.0], 1000.0);
        let low = gain_db([0.0, -9.0, 0.0], 60.0);
        assert!((mid + 9.0).abs() < 0.5, "mid {mid}");
        assert!(low.abs() < 0.8, "low {low}");
    }

    #[test]
    fn the_high_shelf_boosts_treble_and_leaves_bass_alone() {
        let treble = gain_db([0.0, 0.0, 6.0], 15000.0);
        let bass = gain_db([0.0, 0.0, 6.0], 100.0);
        assert!((treble - 6.0).abs() < 0.6, "treble {treble}");
        assert!(bass.abs() < 0.3, "bass {bass}");
    }

    #[test]
    fn the_two_channels_are_filtered_independently() {
        let mut eq = Eq3::new(RATE);
        eq.set_gains(12.0, 0.0, 0.0);
        let mut buf: Vec<f32> = (0..9600).flat_map(|i| [((i as f32) * 0.01).sin(), 0.0]).collect();
        eq.process_stereo(&mut buf);
        assert!(buf.as_chunks::<2>().0.iter().all(|f| f[1] == 0.0));
    }

    fn comp(threshold: f32, ratio: f32) -> CompSettings {
        CompSettings {
            enabled: true,
            threshold_db: threshold,
            ratio,
            attack_ms: 1.0,
            release_ms: 50.0,
            makeup_db: 0.0,
        }
    }

    #[test]
    fn a_disabled_compressor_is_transparent() {
        let mut c = Compressor::new(RATE);
        let original = sine(440.0, 2400, 0.9);
        let mut buf = original.clone();
        let reduction = c.process_stereo(&mut buf, &CompSettings::default());
        assert_eq!(buf, original);
        assert_eq!(reduction, 0.0);
    }

    #[test]
    fn the_compressor_follows_the_ratio_above_the_threshold() {
        let mut c = Compressor::new(RATE);
        let mut buf = sine(440.0, 48000, 0.5);
        let reduction = c.process_stereo(&mut buf, &comp(-20.0, 4.0));
        let in_db = lin_to_db(0.5);
        let expected_reduction = (in_db + 20.0) * (1.0 - 1.0 / 4.0);
        assert!(reduction > expected_reduction * 0.9, "reduction {reduction}");
        let out_peak = buf[buf.len() / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let out_db = lin_to_db(out_peak);
        assert!((out_db - (in_db - expected_reduction)).abs() < 1.0, "out {out_db}");
    }

    #[test]
    fn signals_under_the_threshold_pass_unchanged() {
        let mut c = Compressor::new(RATE);
        let original = sine(440.0, 4800, 0.05);
        let mut buf = original.clone();
        let reduction = c.process_stereo(&mut buf, &comp(-10.0, 8.0));
        assert_eq!(reduction, 0.0);
        assert_eq!(buf, original);
    }

    #[test]
    fn makeup_gain_lifts_the_output() {
        let mut c = Compressor::new(RATE);
        let mut settings = comp(0.0, 2.0);
        settings.makeup_db = 6.0;
        let mut buf = sine(440.0, 4800, 0.1);
        c.process_stereo(&mut buf, &settings);
        let peak = buf.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.1 * db_to_lin(6.0)).abs() < 0.01, "peak {peak}");
    }

    #[test]
    fn the_compressor_releases_after_a_loud_passage() {
        let mut c = Compressor::new(RATE);
        let mut loud = sine(440.0, 4800, 0.9);
        let held = c.process_stereo(&mut loud, &comp(-30.0, 8.0));
        assert!(held > 10.0);
        let mut quiet = vec![0.001f32; 2 * 24000];
        c.process_stereo(&mut quiet, &comp(-30.0, 8.0));
        assert!(quiet.last().copied().unwrap() > 0.0009);
    }

    #[test]
    fn the_limiter_never_exceeds_the_ceiling() {
        let mut l = Limiter::new(RATE);
        let mut buf = sine(100.0, 48000, 4.0);
        let reduction = l.process_stereo(&mut buf, 0.9);
        assert!(buf.iter().all(|v| v.abs() <= 0.9 + 1e-6));
        assert!(reduction > 10.0);
    }

    #[test]
    fn the_limiter_leaves_quiet_material_alone() {
        let mut l = Limiter::new(RATE);
        let original = sine(220.0, 4800, 0.3);
        let mut buf = original.clone();
        let reduction = l.process_stereo(&mut buf, 0.9);
        assert_eq!(buf, original);
        assert_eq!(reduction, 0.0);
    }

    #[test]
    fn the_limiter_recovers_its_gain_after_a_burst() {
        let mut l = Limiter::new(RATE);
        let mut burst = vec![3.0f32; 200];
        l.process_stereo(&mut burst, 0.9);
        let mut quiet = vec![0.2f32; 2 * 48000];
        l.process_stereo(&mut quiet, 0.9);
        assert!((quiet.last().copied().unwrap() - 0.2).abs() < 0.001);
    }

    #[test]
    fn decibel_conversions_round_trip() {
        for db in [-60.0f32, -12.0, 0.0, 6.0] {
            assert!((lin_to_db(db_to_lin(db)) - db).abs() < 1e-3);
        }
    }
}
