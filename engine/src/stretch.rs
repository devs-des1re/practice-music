pub const CHANNELS: usize = 2;

pub struct Stretcher {
    half: usize,
    frame: usize,
    tol: usize,
    speed: f64,
    pitch: f64,
    fifo: Vec<f32>,
    base: usize,
    fed: usize,
    nominal: f64,
    prev: Vec<f32>,
    cand: Vec<f32>,
    started: bool,
    sbuf: Vec<f32>,
    sbase: usize,
    spos: f64,
    scratch: Vec<f32>,
    tail: Vec<f32>,
    up: Vec<f32>,
    down: Vec<f32>,
}

fn mono(frames: &[f32], i: usize) -> f32 {
    0.5 * (frames[i * CHANNELS] + frames[i * CHANNELS + 1])
}

impl Stretcher {
    pub fn new(half: usize) -> Self {
        let frame = half * 2;
        let tol = half / 2;
        let up = (0..half)
            .map(|i| {
                let x = std::f32::consts::FRAC_PI_2 * (i as f32 + 0.5) / half as f32;
                x.sin().powi(2)
            })
            .collect::<Vec<_>>();
        let down = up.iter().map(|u| 1.0 - u).collect();
        let cap = (frame * 6 + half * 4) * CHANNELS;
        Self {
            half,
            frame,
            tol,
            speed: 1.0,
            pitch: 1.0,
            fifo: Vec::with_capacity(cap),
            base: 0,
            fed: 0,
            nominal: 0.0,
            prev: vec![0.0; frame * CHANNELS],
            cand: vec![0.0; frame * CHANNELS],
            started: false,
            sbuf: Vec::with_capacity(cap),
            sbase: 0,
            spos: 0.0,
            scratch: vec![0.0; half * CHANNELS],
            tail: vec![0.0; half],
            up,
            down,
        }
    }

    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed.clamp(0.1, 4.0);
    }

    pub fn set_pitch_semitones(&mut self, semitones: f64) {
        self.pitch = 2f64.powf(semitones.clamp(-24.0, 24.0) / 12.0);
    }

    pub fn reset(&mut self) {
        self.fifo.clear();
        self.base = 0;
        self.fed = 0;
        self.nominal = 0.0;
        self.started = false;
        self.sbuf.clear();
        self.sbase = 0;
        self.spos = 0.0;
    }

    pub fn analysis_position(&self) -> f64 {
        self.nominal
    }

    pub fn fed(&self) -> usize {
        self.fed
    }

    fn analysis_speed(&self) -> f64 {
        self.speed / self.pitch
    }

    fn ensure_input(&mut self, upto: usize, feed: &mut dyn FnMut(&mut [f32])) {
        while self.fed < upto {
            feed(&mut self.scratch);
            self.fifo.extend_from_slice(&self.scratch);
            self.fed += self.half;
        }
    }

    fn compact(&mut self) {
        let keep_from = (self.nominal as usize).saturating_sub(self.tol + 2);
        if keep_from > self.base + self.half * 2 {
            let drop = keep_from - self.base;
            self.fifo.copy_within(drop * CHANNELS.., 0);
            let new_len = self.fifo.len() - drop * CHANNELS;
            self.fifo.truncate(new_len);
            self.base += drop;
        }
    }

    fn cand_start(&mut self, start: usize) -> usize {
        let from = start - self.base;
        let len = self.frame * CHANNELS;
        self.cand
            .copy_from_slice(&self.fifo[from * CHANNELS..from * CHANNELS + len]);
        start
    }

    fn score(&self, start: usize, step: usize) -> f32 {
        let off = start - self.base;
        let mut dot = 0.0f32;
        let mut energy = 1e-6f32;
        let mut i = 0;
        while i < self.half {
            let c = 0.5 * (self.fifo[(off + i) * CHANNELS] + self.fifo[(off + i) * CHANNELS + 1]);
            dot += self.tail[i] * c;
            energy += c * c;
            i += step;
        }
        dot / energy.sqrt()
    }

    fn best_start(&self, nominal: usize) -> usize {
        let lo = nominal.saturating_sub(self.tol).max(self.base);
        let hi = nominal + self.tol;
        let mut best = nominal.clamp(lo, hi);
        let mut best_score = f32::MIN;
        let mut c = lo;
        while c <= hi {
            let s = self.score(c, 4);
            if s > best_score {
                best_score = s;
                best = c;
            }
            c += 4;
        }
        let lo2 = best.saturating_sub(4).max(lo);
        let hi2 = (best + 4).min(hi);
        let mut c = lo2;
        while c <= hi2 {
            let s = self.score(c, 2);
            if s > best_score {
                best_score = s;
                best = c;
            }
            c += 1;
        }
        best
    }

    fn make_block(&mut self, feed: &mut dyn FnMut(&mut [f32])) {
        let nominal = self.nominal.max(0.0).round() as usize;
        self.ensure_input(nominal + self.tol + self.frame + self.half, feed);
        if !self.started {
            let start = nominal.max(self.base);
            self.cand_start(start);
            self.prev.copy_from_slice(&self.cand);
            self.sbuf
                .extend_from_slice(&self.prev[..self.half * CHANNELS]);
            self.started = true;
        } else {
            for i in 0..self.half {
                self.tail[i] = mono(&self.prev[self.half * CHANNELS..], i);
            }
            let start = self.best_start(nominal);
            self.cand_start(start);
            for i in 0..self.half {
                let d = self.down[i];
                let u = self.up[i];
                for ch in 0..CHANNELS {
                    let p = self.prev[(self.half + i) * CHANNELS + ch];
                    let c = self.cand[i * CHANNELS + ch];
                    self.sbuf.push(p * d + c * u);
                }
            }
            std::mem::swap(&mut self.prev, &mut self.cand);
        }
        self.nominal += self.half as f64 * self.analysis_speed();
        self.compact();
    }

    fn stretched_frames(&self) -> usize {
        self.sbase + self.sbuf.len() / CHANNELS
    }

    fn sample(&self, index: isize, ch: usize) -> f32 {
        let i = index.max(self.sbase as isize) as usize - self.sbase;
        let i = i.min(self.sbuf.len() / CHANNELS - 1);
        self.sbuf[i * CHANNELS + ch]
    }

    pub fn render(&mut self, out: &mut [f32], feed: &mut dyn FnMut(&mut [f32])) {
        let frames = out.len() / CHANNELS;
        let r = self.pitch;
        let exact = (r - 1.0).abs() < 1e-9;
        for i in 0..frames {
            let need = self.spos.floor() as usize + if exact { 1 } else { 3 };
            while self.stretched_frames() < need {
                self.make_block(feed);
            }
            if exact {
                let idx = self.spos as isize;
                for ch in 0..CHANNELS {
                    out[i * CHANNELS + ch] = self.sample(idx, ch);
                }
            } else {
                let base = self.spos.floor();
                let t = (self.spos - base) as f32;
                let b = base as isize;
                for ch in 0..CHANNELS {
                    let y0 = self.sample(b - 1, ch);
                    let y1 = self.sample(b, ch);
                    let y2 = self.sample(b + 1, ch);
                    let y3 = self.sample(b + 2, ch);
                    let c0 = y1;
                    let c1 = 0.5 * (y2 - y0);
                    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
                    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
                    out[i * CHANNELS + ch] = ((c3 * t + c2) * t + c1) * t + c0;
                }
            }
            self.spos += r;
        }
        let drop = (self.spos.floor() as usize).saturating_sub(self.sbase + 2);
        if drop > self.half {
            self.sbuf.copy_within(drop * CHANNELS.., 0);
            let new_len = self.sbuf.len() - drop * CHANNELS;
            self.sbuf.truncate(new_len);
            self.sbase += drop;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::f32::consts::PI;

    const RATE: f32 = 44100.0;

    fn sine(freq: f32, seconds: f32) -> Vec<f32> {
        let n = (RATE * seconds) as usize;
        (0..n)
            .flat_map(|i| {
                let v = (2.0 * PI * freq * i as f32 / RATE).sin() * 0.5;
                [v, v]
            })
            .collect()
    }

    fn run(input: &[f32], speed: f64, semitones: f64, out_frames: usize) -> Vec<f32> {
        let mut s = Stretcher::new(1024);
        s.set_speed(speed);
        s.set_pitch_semitones(semitones);
        let pos = Cell::new(0usize);
        let mut feed = |buf: &mut [f32]| {
            for v in buf.iter_mut() {
                let p = pos.get();
                *v = if p < input.len() { input[p] } else { 0.0 };
                pos.set(p + 1);
            }
        };
        let mut out = vec![0.0f32; out_frames * CHANNELS];
        for chunk in out.chunks_mut(480 * CHANNELS) {
            s.render(chunk, &mut feed);
        }
        out
    }

    fn frequency(signal: &[f32]) -> f32 {
        let mono: Vec<f32> = signal.chunks(2).map(|f| f[0]).collect();
        let mut crossings = 0;
        for w in mono.windows(2) {
            if w[0] <= 0.0 && w[1] > 0.0 {
                crossings += 1;
            }
        }
        crossings as f32 / (mono.len() as f32 / RATE)
    }

    fn rms(signal: &[f32]) -> f32 {
        (signal.iter().map(|v| v * v).sum::<f32>() / signal.len() as f32).sqrt()
    }

    #[test]
    fn half_speed_doubles_the_length_and_keeps_the_pitch() {
        let input = sine(440.0, 6.0);
        let out = run(&input, 0.5, 0.0, (RATE * 10.0) as usize);
        let steady = &out[(RATE as usize) * 2 * CHANNELS..(RATE as usize) * 8 * CHANNELS];
        let f = frequency(steady);
        assert!((f - 440.0).abs() < 8.0, "frequency {f}");
        assert!(rms(steady) > 0.3, "level {}", rms(steady));
    }

    #[test]
    fn double_speed_halves_the_length_and_keeps_the_pitch() {
        let input = sine(440.0, 6.0);
        let out = run(&input, 2.0, 0.0, (RATE * 4.0) as usize);
        let steady = &out[(RATE as usize / 2) * CHANNELS..(RATE as usize * 2) * CHANNELS];
        let f = frequency(steady);
        assert!((f - 440.0).abs() < 10.0, "frequency {f}");
        let late = &out[(RATE as usize * 3 + 4000) * CHANNELS..];
        assert!(
            rms(late) < 0.05,
            "after the source ends the output must fall silent, rms {}",
            rms(late)
        );
    }

    #[test]
    fn output_ends_when_the_source_ends_at_the_expected_time() {
        let input = sine(330.0, 4.0);
        let out = run(&input, 0.5, 0.0, (RATE * 12.0) as usize);
        let frames = out.len() / 2;
        let mut last_loud = 0;
        for i in 0..frames {
            if out[i * 2].abs() > 0.1 {
                last_loud = i;
            }
        }
        let seconds = last_loud as f32 / RATE;
        assert!(
            (seconds - 8.0).abs() < 0.2,
            "sound ended at {seconds}s, expected about 8s"
        );
    }

    #[test]
    fn pitch_shift_up_an_octave_keeps_the_duration() {
        let input = sine(440.0, 6.0);
        let out = run(&input, 1.0, 12.0, (RATE * 4.0) as usize);
        let steady = &out[(RATE as usize / 2) * CHANNELS..(RATE as usize * 3) * CHANNELS];
        let f = frequency(steady);
        assert!((f - 880.0).abs() < 15.0, "frequency {f}");
        assert!(rms(steady) > 0.3);
    }

    #[test]
    fn pitch_shift_down_with_slower_speed_combines_both() {
        let input = sine(440.0, 8.0);
        let out = run(&input, 0.75, -12.0, (RATE * 5.0) as usize);
        let steady = &out[(RATE as usize) * CHANNELS..(RATE as usize * 4) * CHANNELS];
        let f = frequency(steady);
        assert!((f - 220.0).abs() < 8.0, "frequency {f}");
    }

    #[test]
    fn a_click_train_keeps_its_rhythm_when_slowed() {
        let rate = RATE as usize;
        let mut input = vec![0.0f32; rate * 8 * CHANNELS];
        for beat in 0..16 {
            let at = beat * rate / 2;
            for k in 0..200 {
                let v = (1.0 - k as f32 / 200.0) * (2.0 * PI * 1000.0 * k as f32 / RATE).sin();
                input[(at + k) * 2] = v;
                input[(at + k) * 2 + 1] = v;
            }
        }
        let out = run(&input, 0.5, 0.0, rate * 16);
        let mut onsets = Vec::new();
        let mut quiet = true;
        for i in 0..out.len() / 2 {
            let v = out[i * 2].abs();
            if v > 0.3 && quiet {
                onsets.push(i);
                quiet = false;
            }
            if v < 0.02 && i > onsets.last().copied().unwrap_or(0) + 4000 {
                quiet = true;
            }
        }
        assert!(onsets.len() >= 10, "onsets {}", onsets.len());
        for w in onsets.windows(2).take(10) {
            let gap = (w[1] - w[0]) as f32 / RATE;
            assert!(
                (gap - 1.0).abs() < 0.06,
                "gap {gap}s, expected 1s at half speed"
            );
        }
    }

    #[test]
    fn output_is_finite_and_bounded_across_speed_changes() {
        let input = sine(220.0, 10.0);
        let mut s = Stretcher::new(1024);
        let pos = Cell::new(0usize);
        let mut feed = |buf: &mut [f32]| {
            for v in buf.iter_mut() {
                let p = pos.get();
                *v = if p < input.len() { input[p] } else { 0.0 };
                pos.set(p + 1);
            }
        };
        let mut out = vec![0.0f32; 480 * CHANNELS];
        for step in 0..400 {
            s.set_speed(0.5 + (step % 20) as f64 * 0.075);
            s.set_pitch_semitones(((step / 40) % 5) as f64 - 2.0);
            s.render(&mut out, &mut feed);
            assert!(
                out.iter().all(|v| v.is_finite() && v.abs() < 1.2),
                "bad sample at step {step}"
            );
        }
    }

    #[test]
    fn analysis_position_advances_at_the_requested_speed() {
        let input = sine(440.0, 10.0);
        let mut s = Stretcher::new(1024);
        s.set_speed(0.5);
        let pos = Cell::new(0usize);
        let mut feed = |buf: &mut [f32]| {
            for v in buf.iter_mut() {
                let p = pos.get();
                *v = if p < input.len() { input[p] } else { 0.0 };
                pos.set(p + 1);
            }
        };
        let mut out = vec![0.0f32; RATE as usize * CHANNELS];
        s.render(&mut out, &mut feed);
        let advanced = s.analysis_position();
        assert!(
            (advanced / RATE as f64 - 0.5).abs() < 0.1,
            "after 1 s of output the source advanced {advanced} frames"
        );
    }

    #[test]
    fn reset_starts_a_fresh_stream() {
        let input = sine(440.0, 3.0);
        let mut s = Stretcher::new(1024);
        let pos = Cell::new(0usize);
        let mut feed = |buf: &mut [f32]| {
            for v in buf.iter_mut() {
                let p = pos.get();
                *v = if p < input.len() { input[p] } else { 0.0 };
                pos.set(p + 1);
            }
        };
        let mut out = vec![0.0f32; 4800 * CHANNELS];
        s.set_speed(0.7);
        s.render(&mut out, &mut feed);
        s.reset();
        pos.set(0);
        s.render(&mut out, &mut feed);
        assert_eq!(s.fed() % 1024, 0);
        assert!(rms(&out) > 0.2);
    }
}
