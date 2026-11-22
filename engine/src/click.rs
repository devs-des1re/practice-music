use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

pub const MIN_BPM: f64 = 20.0;
pub const MAX_BPM: f64 = 400.0;

pub struct Controls {
    bpm: AtomicU64,
    volume: AtomicU32,
    running: AtomicBool,
    beats_per_bar: AtomicU32,
    trigger_seq: AtomicU64,
}

impl Controls {
    pub fn new() -> Self {
        Self {
            bpm: AtomicU64::new(120.0f64.to_bits()),
            volume: AtomicU32::new(0.5f32.to_bits()),
            running: AtomicBool::new(false),
            beats_per_bar: AtomicU32::new(4),
            trigger_seq: AtomicU64::new(0),
        }
    }

    pub fn set_bpm(&self, bpm: f64) {
        self.bpm.store(bpm.to_bits(), Ordering::Relaxed);
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume.store(volume.to_bits(), Ordering::Relaxed);
    }

    pub fn set_running(&self, running: bool) {
        self.running.store(running, Ordering::Release);
    }

    pub fn set_beats_per_bar(&self, beats: u32) {
        self.beats_per_bar.store(beats, Ordering::Relaxed);
    }

    pub fn trigger(&self) -> u64 {
        self.trigger_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn bpm(&self) -> f64 {
        f64::from_bits(self.bpm.load(Ordering::Relaxed))
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn beats_per_bar(&self) -> u32 {
        self.beats_per_bar.load(Ordering::Relaxed)
    }
}

impl Default for Controls {
    fn default() -> Self {
        Self::new()
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Voice {
    Idle,
    Normal(usize),
    Accent(usize),
}

pub struct Renderer {
    rate: f64,
    channels: usize,
    normal: Box<[f32]>,
    accent: Box<[f32]>,
    clock: u64,
    running: bool,
    bpm: f64,
    volume: f32,
    beats_per_bar: u32,
    next_beat: f64,
    next_beat_frame: u64,
    beat_index: u64,
    voice: Voice,
    pending_trigger: Option<u64>,
    seen_trigger: u64,
}

impl Renderer {
    pub fn new(rate: u32, channels: usize, normal: Box<[f32]>, accent: Box<[f32]>) -> Self {
        Self {
            rate: f64::from(rate),
            channels: channels.max(1),
            normal,
            accent,
            clock: 0,
            running: false,
            bpm: 120.0,
            volume: 0.5,
            beats_per_bar: 4,
            next_beat: 0.0,
            next_beat_frame: 0,
            beat_index: 0,
            voice: Voice::Idle,
            pending_trigger: None,
            seen_trigger: 0,
        }
    }

    pub fn with_builtin(rate: u32, channels: usize) -> Self {
        Self::new(
            rate,
            channels,
            builtin_click(rate, 1000.0, 0.9),
            builtin_click(rate, 1600.0, 1.0),
        )
    }

    pub fn frames_per_beat(&self) -> f64 {
        self.rate * 60.0 / self.bpm
    }

    pub fn start(&mut self) {
        self.running = true;
        self.beat_index = 0;
        self.next_beat = self.clock as f64;
        self.next_beat_frame = self.clock;
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        self.bpm = bpm.clamp(MIN_BPM, MAX_BPM);
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_beats_per_bar(&mut self, beats: u32) {
        self.beats_per_bar = beats.max(1);
    }

    pub fn trigger_now(&mut self, id: u64) {
        self.pending_trigger = Some(id);
    }

    pub fn apply(&mut self, controls: &Controls) {
        self.set_tempo(controls.bpm());
        self.set_volume(controls.volume());
        self.set_beats_per_bar(controls.beats_per_bar());
        let want = controls.running();
        if want && !self.running {
            self.start();
        } else if !want && self.running {
            self.stop();
        }
        let seq = controls.trigger_seq.load(Ordering::Acquire);
        if seq != self.seen_trigger {
            self.seen_trigger = seq;
            self.trigger_now(seq);
        }
    }

    fn fire_beat(&mut self) {
        let accented = self.beats_per_bar > 1
            && self
                .beat_index
                .is_multiple_of(u64::from(self.beats_per_bar));
        self.voice = if accented {
            Voice::Accent(0)
        } else {
            Voice::Normal(0)
        };
        self.beat_index += 1;
    }

    pub fn render(&mut self, out: &mut [f32]) -> Option<u64> {
        out.fill(0.0);
        let frames = out.len() / self.channels;
        let started = self.pending_trigger.take();
        if started.is_some() {
            self.voice = Voice::Normal(0);
        }
        let fpb = self.frames_per_beat();
        let write = self.channels.min(2);
        for i in 0..frames {
            let abs = self.clock + i as u64;
            while self.running && abs >= self.next_beat_frame {
                if self.next_beat_frame == abs {
                    self.fire_beat();
                }
                self.next_beat += fpb;
                self.next_beat_frame = self.next_beat.round() as u64;
            }
            let (table, pos) = match self.voice {
                Voice::Idle => continue,
                Voice::Normal(p) => (&self.normal, p),
                Voice::Accent(p) => (&self.accent, p),
            };
            let sample = table[pos] * self.volume;
            let base = i * self.channels;
            out[base..base + write].fill(sample);
            let next = pos + 1;
            self.voice = if next >= table.len() {
                Voice::Idle
            } else if matches!(self.voice, Voice::Accent(_)) {
                Voice::Accent(next)
            } else {
                Voice::Normal(next)
            };
        }
        self.clock += frames as u64;
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn impulse_renderer(rate: u32, channels: usize) -> Renderer {
        Renderer::new(rate, channels, Box::new([1.0]), Box::new([2.0]))
    }

    fn render_chunked(
        r: &mut Renderer,
        total_frames: usize,
        chunk: usize,
        channels: usize,
    ) -> Vec<f32> {
        let mut mono = Vec::with_capacity(total_frames);
        let mut buf = vec![0.0f32; chunk * channels];
        while mono.len() < total_frames {
            let n = chunk.min(total_frames - mono.len());
            r.render(&mut buf[..n * channels]);
            for f in 0..n {
                mono.push(buf[f * channels]);
            }
        }
        mono
    }

    fn onsets(signal: &[f32]) -> Vec<usize> {
        signal
            .iter()
            .enumerate()
            .filter(|(_, v)| **v != 0.0)
            .map(|(i, _)| i)
            .collect()
    }

    fn expected(rate: u32, bpm: f64, count: usize) -> Vec<usize> {
        let fpb = f64::from(rate) * 60.0 / bpm;
        (0..count)
            .map(|k| (k as f64 * fpb).round() as usize)
            .collect()
    }

    #[test]
    fn clicks_land_on_exact_frames_at_a_round_tempo() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.set_tempo(120.0);
        r.start();
        let signal = render_chunked(&mut r, 48000 * 4, 480, 1);
        assert_eq!(onsets(&signal), expected(48000, 120.0, 8));
    }

    #[test]
    fn spacing_is_exact_for_tempos_that_do_not_divide_the_rate() {
        for bpm in [97.0, 133.3, 137.0, 211.7] {
            let mut r = impulse_renderer(44100, 1);
            r.set_volume(1.0);
            r.set_tempo(bpm);
            r.start();
            let signal = render_chunked(&mut r, 44100 * 20, 441, 1);
            let got = onsets(&signal);
            assert_eq!(got, expected(44100, bpm, got.len()), "bpm {bpm}");
            assert!(got.len() > 10);
        }
    }

    #[test]
    fn buffer_size_never_moves_a_click() {
        let reference = {
            let mut r = impulse_renderer(48000, 1);
            r.set_volume(1.0);
            r.set_tempo(143.0);
            r.start();
            onsets(&render_chunked(&mut r, 48000 * 10, 480, 1))
        };
        for chunk in [1, 7, 32, 64, 127, 256, 1024, 4096] {
            let mut r = impulse_renderer(48000, 1);
            r.set_volume(1.0);
            r.set_tempo(143.0);
            r.start();
            let got = onsets(&render_chunked(&mut r, 48000 * 10, chunk, 1));
            assert_eq!(got, reference, "chunk {chunk}");
        }
    }

    #[test]
    fn five_minutes_of_clicks_do_not_drift() {
        let rate = 44100;
        let bpm = 137.3;
        let mut r = impulse_renderer(rate, 1);
        r.set_volume(1.0);
        r.set_tempo(bpm);
        r.start();
        let total = rate as usize * 300;
        let got = onsets(&render_chunked(&mut r, total, 512, 1));
        let want = expected(rate, bpm, got.len());
        assert_eq!(got, want);
        let last = *got.last().unwrap() as f64;
        let ideal = (got.len() - 1) as f64 * f64::from(rate) * 60.0 / bpm;
        assert!((last - ideal).abs() <= 0.5, "drift {} frames", last - ideal);
    }

    #[test]
    fn the_first_click_is_on_the_first_frame_after_start() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        let _ = render_chunked(&mut r, 1000, 100, 1);
        r.start();
        let signal = render_chunked(&mut r, 100, 100, 1);
        assert_eq!(onsets(&signal), vec![0]);
    }

    #[test]
    fn accent_marks_the_first_beat_of_each_bar() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.set_tempo(120.0);
        r.set_beats_per_bar(3);
        r.start();
        let signal = render_chunked(&mut r, 48000 * 4, 256, 1);
        let values: Vec<f32> = onsets(&signal).iter().map(|&i| signal[i]).collect();
        assert_eq!(values, vec![2.0, 1.0, 1.0, 2.0, 1.0, 1.0, 2.0, 1.0]);
    }

    #[test]
    fn a_single_beat_per_bar_never_accents() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.set_beats_per_bar(1);
        r.start();
        let signal = render_chunked(&mut r, 48000 * 3, 256, 1);
        assert!(onsets(&signal).iter().all(|&i| signal[i] == 1.0));
    }

    #[test]
    fn a_one_shot_trigger_sounds_on_the_first_frame_of_the_next_buffer() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        let _ = render_chunked(&mut r, 333, 111, 1);
        r.trigger_now(9);
        let mut buf = vec![0.0f32; 64];
        assert_eq!(r.render(&mut buf), Some(9));
        assert_eq!(onsets(&buf), vec![0]);
        assert_eq!(r.render(&mut buf), None);
        assert!(onsets(&buf).is_empty());
    }

    #[test]
    fn a_one_shot_does_not_disturb_the_running_schedule() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.set_tempo(120.0);
        r.start();
        let mut signal = render_chunked(&mut r, 10000, 500, 1);
        r.trigger_now(1);
        signal.extend(render_chunked(&mut r, 100000 - 10000, 500, 1));
        let got = onsets(&signal);
        assert!(got.contains(&10000));
        let beats: Vec<usize> = got.into_iter().filter(|&i| i != 10000).collect();
        assert_eq!(beats, expected(48000, 120.0, beats.len()));
    }

    #[test]
    fn stopping_silences_the_click_and_restarting_realigns_to_the_buffer() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.start();
        let _ = render_chunked(&mut r, 1000, 100, 1);
        r.stop();
        assert!(onsets(&render_chunked(&mut r, 100000, 500, 1)).is_empty());
        r.start();
        let signal = render_chunked(&mut r, 50, 50, 1);
        assert_eq!(onsets(&signal), vec![0]);
    }

    #[test]
    fn tempo_changes_apply_to_the_following_beats() {
        let mut r = impulse_renderer(48000, 1);
        r.set_volume(1.0);
        r.set_tempo(60.0);
        r.start();
        let mut signal = render_chunked(&mut r, 48000, 480, 1);
        r.set_tempo(120.0);
        signal.extend(render_chunked(&mut r, 48000 * 2, 480, 1));
        let got = onsets(&signal);
        assert_eq!(got[0], 0);
        assert_eq!(got[1], 48000);
        assert_eq!(got[2] - got[1], 24000);
        assert_eq!(got[3] - got[2], 24000);
    }

    #[test]
    fn volume_scales_the_output_and_zero_is_silent() {
        let mut r = Renderer::new(48000, 1, Box::new([1.0]), Box::new([1.0]));
        r.set_volume(0.25);
        r.start();
        let signal = render_chunked(&mut r, 100, 100, 1);
        assert_eq!(signal[0], 0.25);
        let mut r = Renderer::new(48000, 1, Box::new([1.0]), Box::new([1.0]));
        r.set_volume(0.0);
        r.start();
        assert!(
            render_chunked(&mut r, 100, 100, 1)
                .iter()
                .all(|v| *v == 0.0)
        );
    }

    #[test]
    fn stereo_output_duplicates_the_click_and_extra_channels_stay_silent() {
        let mut r = impulse_renderer(48000, 4);
        r.set_volume(1.0);
        r.trigger_now(1);
        let mut buf = vec![0.0f32; 4 * 8];
        r.render(&mut buf);
        assert_eq!(&buf[0..4], &[1.0, 1.0, 0.0, 0.0]);
        assert!(buf[4..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn controls_drive_the_renderer_through_atomics() {
        let controls = Controls::new();
        let mut r = impulse_renderer(48000, 1);
        controls.set_volume(1.0);
        controls.set_bpm(120.0);
        controls.set_running(true);
        r.apply(&controls);
        let first = render_chunked(&mut r, 24000, 256, 1);
        assert_eq!(onsets(&first), vec![0]);
        let id = controls.trigger();
        r.apply(&controls);
        let mut buf = vec![0.0f32; 16];
        assert_eq!(r.render(&mut buf), Some(id));
        controls.set_running(false);
        r.apply(&controls);
        assert!(onsets(&render_chunked(&mut r, 48000, 256, 1)).is_empty());
    }

    #[test]
    fn tempo_is_clamped_to_a_sane_range() {
        let mut r = impulse_renderer(48000, 1);
        r.set_tempo(1.0);
        assert_eq!(r.frames_per_beat(), 48000.0 * 60.0 / MIN_BPM);
        r.set_tempo(10000.0);
        assert_eq!(r.frames_per_beat(), 48000.0 * 60.0 / MAX_BPM);
    }

    #[test]
    fn the_builtin_click_has_an_audible_onset_and_decays() {
        let table = builtin_click(48000, 1000.0, 0.9);
        assert!(table.len() > 1000);
        let early = table[..240].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let late = table[table.len() - 100..]
            .iter()
            .fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(early > 0.3, "early peak {early}");
        assert!(late < 0.05, "tail {late}");
    }
}
