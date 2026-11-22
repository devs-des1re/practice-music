use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::sounds::{self, ROLE_ACCENT, ROLE_BEAT, ROLE_POLY, ROLE_SUB, ROLES};

pub const MIN_BPM: f64 = 20.0;
pub const MAX_BPM: f64 = 400.0;
pub const MAX_BEATS: u32 = 32;
pub const MAX_SUBDIVISION: u32 = 8;
pub const MAX_POLY: u32 = 32;
pub const MAX_BAR_COUNT: u32 = 64;

#[cfg(test)]
pub const LEVEL_MUTE: u8 = 0;
pub const LEVEL_SOFT: u8 = 1;
pub const LEVEL_NORMAL: u8 = 2;
pub const LEVEL_ACCENT: u8 = 3;

const MAX_VOICES: usize = 16;
const MAX_EVENTS: usize = 64;
const SOFT_GAIN: f32 = 0.5;
const NO_ROLE: u8 = 255;

pub fn default_accents() -> u64 {
    let mut pattern = 0u64;
    for beat in 0..MAX_BEATS {
        let level = if beat == 0 { LEVEL_ACCENT } else { LEVEL_NORMAL };
        pattern |= u64::from(level) << (2 * beat);
    }
    pattern
}

pub fn pack_accents(levels: &[u8]) -> u64 {
    let mut pattern = default_accents();
    for (beat, level) in levels.iter().take(MAX_BEATS as usize).enumerate() {
        pattern &= !(3u64 << (2 * beat));
        pattern |= u64::from((*level).min(LEVEL_ACCENT)) << (2 * beat);
    }
    pattern
}

pub fn unpack_accents(pattern: u64, beats: u32) -> Vec<u8> {
    (0..beats.min(MAX_BEATS))
        .map(|beat| ((pattern >> (2 * beat)) & 3) as u8)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeatInfo {
    pub beat: u32,
    pub bar: u32,
    pub beats_per_bar: u32,
    pub level: u8,
    pub silent: bool,
}

impl BeatInfo {
    pub fn pack(self) -> u64 {
        (u64::from(self.beat) & 0xff)
            | ((u64::from(self.beats_per_bar) & 0xff) << 8)
            | ((u64::from(self.level) & 3) << 16)
            | (u64::from(self.silent) << 18)
            | (u64::from(self.bar) << 24)
    }

    pub fn unpack(word: u64) -> Self {
        Self {
            beat: (word & 0xff) as u32,
            beats_per_bar: ((word >> 8) & 0xff) as u32,
            level: ((word >> 16) & 3) as u8,
            silent: (word >> 18) & 1 == 1,
            bar: (word >> 24) as u32,
        }
    }
}

pub struct Controls {
    bpm: AtomicU64,
    volume: AtomicU32,
    running: AtomicBool,
    beats_per_bar: AtomicU32,
    trigger_seq: AtomicU64,
    subdivision: AtomicU32,
    sub_level: AtomicU32,
    accents: AtomicU64,
    poly_beats: AtomicU32,
    poly_level: AtomicU32,
    play_bars: AtomicU32,
    silent_bars: AtomicU32,
    beat_seq: AtomicU64,
    beat_word: AtomicU64,
}

impl Controls {
    pub fn new() -> Self {
        Self {
            bpm: AtomicU64::new(120.0f64.to_bits()),
            volume: AtomicU32::new(0.5f32.to_bits()),
            running: AtomicBool::new(false),
            beats_per_bar: AtomicU32::new(4),
            trigger_seq: AtomicU64::new(0),
            subdivision: AtomicU32::new(1),
            sub_level: AtomicU32::new(0.55f32.to_bits()),
            accents: AtomicU64::new(default_accents()),
            poly_beats: AtomicU32::new(0),
            poly_level: AtomicU32::new(0.8f32.to_bits()),
            play_bars: AtomicU32::new(1),
            silent_bars: AtomicU32::new(0),
            beat_seq: AtomicU64::new(0),
            beat_word: AtomicU64::new(0),
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

    pub fn set_subdivision(&self, subdivision: u32) {
        self.subdivision.store(subdivision, Ordering::Relaxed);
    }

    pub fn set_sub_level(&self, level: f32) {
        self.sub_level.store(level.to_bits(), Ordering::Relaxed);
    }

    pub fn set_accents(&self, pattern: u64) {
        self.accents.store(pattern, Ordering::Relaxed);
    }

    pub fn set_poly(&self, beats: u32) {
        self.poly_beats.store(beats, Ordering::Relaxed);
    }

    pub fn set_poly_level(&self, level: f32) {
        self.poly_level.store(level.to_bits(), Ordering::Relaxed);
    }

    pub fn set_silence(&self, play_bars: u32, silent_bars: u32) {
        self.play_bars.store(play_bars, Ordering::Relaxed);
        self.silent_bars.store(silent_bars, Ordering::Relaxed);
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

    pub fn subdivision(&self) -> u32 {
        self.subdivision.load(Ordering::Relaxed)
    }

    pub fn sub_level(&self) -> f32 {
        f32::from_bits(self.sub_level.load(Ordering::Relaxed))
    }

    pub fn accents(&self) -> u64 {
        self.accents.load(Ordering::Relaxed)
    }

    pub fn poly(&self) -> u32 {
        self.poly_beats.load(Ordering::Relaxed)
    }

    pub fn poly_level(&self) -> f32 {
        f32::from_bits(self.poly_level.load(Ordering::Relaxed))
    }

    pub fn silence(&self) -> (u32, u32) {
        (
            self.play_bars.load(Ordering::Relaxed),
            self.silent_bars.load(Ordering::Relaxed),
        )
    }

    pub fn publish_beat(&self, seq: u64, info: BeatInfo) {
        self.beat_word.store(info.pack(), Ordering::Relaxed);
        self.beat_seq.store(seq, Ordering::Release);
    }

    pub fn beat(&self) -> (u64, BeatInfo) {
        let seq = self.beat_seq.load(Ordering::Acquire);
        (seq, BeatInfo::unpack(self.beat_word.load(Ordering::Relaxed)))
    }
}

impl Default for Controls {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    role: u8,
    pos: usize,
    gain: f32,
}

const IDLE_VOICE: Voice = Voice {
    active: false,
    role: 0,
    pos: 0,
    gain: 0.0,
};

#[derive(Clone, Copy)]
struct Event {
    frame: u64,
    role: u8,
    gain: f32,
    beat: Option<BeatInfo>,
}

const EMPTY_EVENT: Event = Event {
    frame: 0,
    role: NO_ROLE,
    gain: 0.0,
    beat: None,
};

pub struct Renderer {
    rate: f64,
    channels: usize,
    tables: [Arc<[f32]>; ROLES],
    voices: [Voice; MAX_VOICES],
    events: [Event; MAX_EVENTS],
    ev_head: usize,
    ev_len: usize,
    clock: u64,
    running: bool,
    bpm: f64,
    volume: f32,
    beats_per_bar: u32,
    subdivision: u32,
    sub_level: f32,
    accents: u64,
    poly_beats: u32,
    poly_level: f32,
    play_bars: u32,
    silent_bars: u32,
    next_beat: f64,
    next_beat_frame: u64,
    beat_index: u64,
    bar_start: f64,
    bar_length: f64,
    poly_next: u32,
    pending_trigger: Option<u64>,
    seen_trigger: u64,
    beat_counter: u64,
    last_beat: BeatInfo,
}

impl Renderer {
    pub fn new(rate: u32, channels: usize, normal: Box<[f32]>, accent: Box<[f32]>) -> Self {
        let normal: Arc<[f32]> = Arc::from(normal);
        let accent: Arc<[f32]> = Arc::from(accent);
        Self {
            rate: f64::from(rate),
            channels: channels.max(1),
            tables: [
                Arc::clone(&accent),
                Arc::clone(&normal),
                normal,
                accent,
            ],
            voices: [IDLE_VOICE; MAX_VOICES],
            events: [EMPTY_EVENT; MAX_EVENTS],
            ev_head: 0,
            ev_len: 0,
            clock: 0,
            running: false,
            bpm: 120.0,
            volume: 0.5,
            beats_per_bar: 4,
            subdivision: 1,
            sub_level: 0.55,
            accents: default_accents(),
            poly_beats: 0,
            poly_level: 0.8,
            play_bars: 1,
            silent_bars: 0,
            next_beat: 0.0,
            next_beat_frame: 0,
            beat_index: 0,
            bar_start: 0.0,
            bar_length: 0.0,
            poly_next: 0,
            pending_trigger: None,
            seen_trigger: 0,
            beat_counter: 0,
            last_beat: BeatInfo {
                beat: 0,
                bar: 0,
                beats_per_bar: 4,
                level: LEVEL_NORMAL,
                silent: false,
            },
        }
    }

    pub fn with_builtin(rate: u32, channels: usize) -> Self {
        let mut renderer = Self::new(
            rate,
            channels,
            sounds::builtin_click(rate, 1000.0, 0.9),
            sounds::builtin_click(rate, 1600.0, 1.0),
        );
        if let Some(tables) = sounds::preset("click", rate) {
            for (role, table) in tables.into_iter().enumerate() {
                renderer.set_table(role, Arc::from(table));
            }
        }
        renderer
    }

    pub fn set_table(&mut self, role: usize, table: Arc<[f32]>) {
        if role < ROLES && !table.is_empty() {
            self.tables[role] = table;
        }
    }

    pub fn frames_per_beat(&self) -> f64 {
        self.rate * 60.0 / self.bpm
    }

    pub fn start(&mut self) {
        self.running = true;
        self.beat_index = 0;
        self.next_beat = self.clock as f64;
        self.next_beat_frame = self.clock;
        self.ev_head = 0;
        self.ev_len = 0;
        self.poly_next = 0;
    }

    pub fn stop(&mut self) {
        self.running = false;
        self.ev_head = 0;
        self.ev_len = 0;
    }

    pub fn set_tempo(&mut self, bpm: f64) {
        self.bpm = bpm.clamp(MIN_BPM, MAX_BPM);
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_beats_per_bar(&mut self, beats: u32) {
        self.beats_per_bar = beats.clamp(1, MAX_BEATS);
    }

    pub fn set_subdivision(&mut self, subdivision: u32) {
        self.subdivision = subdivision.clamp(1, MAX_SUBDIVISION);
    }

    pub fn set_sub_level(&mut self, level: f32) {
        self.sub_level = level.clamp(0.0, 1.5);
    }

    pub fn set_accents(&mut self, pattern: u64) {
        self.accents = pattern;
    }

    pub fn set_poly(&mut self, beats: u32) {
        self.poly_beats = beats.min(MAX_POLY);
    }

    pub fn set_poly_level(&mut self, level: f32) {
        self.poly_level = level.clamp(0.0, 1.5);
    }

    pub fn set_silence(&mut self, play_bars: u32, silent_bars: u32) {
        self.play_bars = play_bars.clamp(1, MAX_BAR_COUNT);
        self.silent_bars = silent_bars.min(MAX_BAR_COUNT);
    }

    pub fn trigger_now(&mut self, id: u64) {
        self.pending_trigger = Some(id);
    }

    pub fn beat_counter(&self) -> u64 {
        self.beat_counter
    }

    pub fn last_beat(&self) -> BeatInfo {
        self.last_beat
    }

    pub fn apply(&mut self, controls: &Controls) {
        self.set_tempo(controls.bpm());
        self.set_volume(controls.volume());
        self.set_beats_per_bar(controls.beats_per_bar());
        self.set_subdivision(controls.subdivision());
        self.set_sub_level(controls.sub_level());
        self.set_accents(controls.accents());
        self.set_poly(controls.poly());
        self.set_poly_level(controls.poly_level());
        let (play, silent) = controls.silence();
        self.set_silence(play, silent);
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

    fn is_silent_bar(&self, bar: u64) -> bool {
        if self.silent_bars == 0 {
            return false;
        }
        let play = u64::from(self.play_bars.max(1));
        bar % (play + u64::from(self.silent_bars)) >= play
    }

    fn accent_level(&self, beat_in_bar: u32) -> u8 {
        let level = ((self.accents >> (2 * beat_in_bar.min(MAX_BEATS - 1))) & 3) as u8;
        if self.beats_per_bar == 1 && level == LEVEL_ACCENT {
            LEVEL_NORMAL
        } else {
            level
        }
    }

    fn push_event(&mut self, event: Event) {
        if self.ev_len < MAX_EVENTS {
            self.events[self.ev_len] = event;
            self.ev_len += 1;
        }
    }

    fn schedule_beat(&mut self) {
        if self.ev_head > 0 {
            self.events.copy_within(self.ev_head..self.ev_len, 0);
            self.ev_len -= self.ev_head;
            self.ev_head = 0;
        }
        let fpb = self.frames_per_beat();
        let t0 = self.next_beat;
        let first_frame = self.next_beat_frame;
        let bpb = self.beats_per_bar.max(1);
        let beat_in_bar = (self.beat_index % u64::from(bpb)) as u32;
        if beat_in_bar == 0 {
            self.bar_start = t0;
            self.bar_length = fpb * f64::from(bpb);
            self.poly_next = 0;
        }
        let bar = self.beat_index / u64::from(bpb);
        let silent = self.is_silent_bar(bar);
        let level = self.accent_level(beat_in_bar);
        let info = BeatInfo {
            beat: beat_in_bar,
            bar: bar as u32,
            beats_per_bar: bpb,
            level,
            silent,
        };
        let (role, gain) = match level {
            LEVEL_ACCENT => (ROLE_ACCENT as u8, 1.0),
            LEVEL_NORMAL => (ROLE_BEAT as u8, 1.0),
            LEVEL_SOFT => (ROLE_BEAT as u8, SOFT_GAIN),
            _ => (NO_ROLE, 0.0),
        };
        let audible = !silent;
        self.push_event(Event {
            frame: first_frame,
            role: if audible { role } else { NO_ROLE },
            gain,
            beat: Some(info),
        });
        if audible && self.sub_level > 0.0 {
            let divisions = self.subdivision;
            for j in 1..divisions {
                let frame = (t0 + fpb * f64::from(j) / f64::from(divisions)).round() as u64;
                self.push_event(Event {
                    frame,
                    role: ROLE_SUB as u8,
                    gain: self.sub_level,
                    beat: None,
                });
            }
        }
        if self.poly_beats > 0 {
            let last_beat = beat_in_bar + 1 == bpb;
            let count = self.poly_beats;
            while self.poly_next < count {
                let t = self.bar_start + self.bar_length * f64::from(self.poly_next) / f64::from(count);
                if t >= t0 + fpb - 1e-6 && !last_beat {
                    break;
                }
                let frame = (t.round() as u64).max(first_frame);
                if audible {
                    self.push_event(Event {
                        frame,
                        role: ROLE_POLY as u8,
                        gain: self.poly_level,
                        beat: None,
                    });
                }
                self.poly_next += 1;
            }
        }
        self.events[self.ev_head..self.ev_len].sort_by_key(|e| e.frame);
        self.beat_index += 1;
        self.next_beat += fpb;
        self.next_beat_frame = self.next_beat.round() as u64;
    }

    fn start_voice(&mut self, role: u8, gain: f32) {
        let slot = self
            .voices
            .iter()
            .position(|v| !v.active)
            .or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .max_by_key(|(_, v)| v.pos)
                    .map(|(i, _)| i)
            })
            .unwrap_or(0);
        self.voices[slot] = Voice {
            active: true,
            role,
            pos: 0,
            gain,
        };
    }

    fn fire_due(&mut self, abs: u64) {
        while self.ev_head < self.ev_len && self.events[self.ev_head].frame <= abs {
            let event = self.events[self.ev_head];
            self.ev_head += 1;
            if let Some(info) = event.beat {
                self.last_beat = info;
                self.beat_counter += 1;
            }
            if event.role != NO_ROLE && event.gain > 0.0 {
                self.start_voice(event.role, event.gain);
            }
        }
    }

    pub fn render(&mut self, out: &mut [f32]) -> Option<u64> {
        out.fill(0.0);
        let frames = out.len() / self.channels;
        let started = self.pending_trigger.take();
        if started.is_some() {
            self.start_voice(ROLE_BEAT as u8, 1.0);
        }
        let write = self.channels.min(2);
        for i in 0..frames {
            let abs = self.clock + i as u64;
            if self.running {
                self.fire_due(abs);
                while abs >= self.next_beat_frame {
                    self.schedule_beat();
                    self.fire_due(abs);
                }
            }
            let mut sample = 0.0f32;
            let mut any = false;
            for voice in self.voices.iter_mut() {
                if !voice.active {
                    continue;
                }
                any = true;
                let table = &self.tables[usize::from(voice.role)];
                sample += table[voice.pos] * voice.gain;
                voice.pos += 1;
                if voice.pos >= table.len() {
                    voice.active = false;
                }
            }
            if any {
                let base = i * self.channels;
                out[base..base + write].fill(sample * self.volume);
            }
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

    fn role_renderer(rate: u32) -> Renderer {
        let mut r = impulse_renderer(rate, 1);
        r.set_table(ROLE_ACCENT, Arc::from(vec![8.0f32]));
        r.set_table(ROLE_BEAT, Arc::from(vec![4.0f32]));
        r.set_table(ROLE_SUB, Arc::from(vec![2.0f32]));
        r.set_table(ROLE_POLY, Arc::from(vec![1.0f32]));
        r.set_volume(1.0);
        r.set_sub_level(1.0);
        r.set_poly_level(1.0);
        r
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

    fn pairs(signal: &[f32]) -> Vec<(usize, f32)> {
        onsets(signal).into_iter().map(|i| (i, signal[i])).collect()
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
        let table = sounds::builtin_click(48000, 1000.0, 0.9);
        assert!(table.len() > 1000);
        let early = table[..240].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let late = table[table.len() - 100..]
            .iter()
            .fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(early > 0.3, "early peak {early}");
        assert!(late < 0.05, "tail {late}");
    }

    #[test]
    fn subdivisions_split_every_beat_into_exact_parts() {
        for (bpm, divisions) in [(120.0, 2u32), (137.0, 3), (100.0, 4), (91.0, 5)] {
            let mut r = role_renderer(44100);
            r.set_tempo(bpm);
            r.set_subdivision(divisions);
            r.start();
            let signal = render_chunked(&mut r, 44100 * 8, 333, 1);
            let fpb = 44100.0 * 60.0 / bpm;
            let got = pairs(&signal);
            let beats = (8.0 * bpm / 60.0).ceil() as usize;
            let mut want: Vec<(usize, f32)> = Vec::new();
            for b in 0..beats {
                let t0 = b as f64 * fpb;
                let value = if b % 4 == 0 { 8.0 } else { 4.0 };
                want.push((t0.round() as usize, value));
                for j in 1..divisions {
                    want.push(((t0 + fpb * f64::from(j) / f64::from(divisions)).round() as usize, 2.0));
                }
            }
            want.retain(|(f, _)| *f < 44100 * 8);
            assert_eq!(got, want, "bpm {bpm} divisions {divisions}");
        }
    }

    #[test]
    fn a_zero_sub_level_removes_the_subdivision_clicks() {
        let mut r = role_renderer(48000);
        r.set_subdivision(4);
        r.set_sub_level(0.0);
        r.start();
        let signal = render_chunked(&mut r, 48000 * 4, 256, 1);
        assert_eq!(onsets(&signal), expected(48000, 120.0, 8));
    }

    #[test]
    fn a_polyrhythm_spreads_its_clicks_evenly_across_the_bar() {
        let mut r = role_renderer(48000);
        r.set_beats_per_bar(4);
        r.set_poly(3);
        r.set_tempo(120.0);
        r.start();
        let signal = render_chunked(&mut r, 96000 * 2, 500, 1);
        let poly: Vec<usize> = pairs(&signal)
            .into_iter()
            .filter(|(_, v)| *v == 1.0 || *v == 9.0 || *v == 5.0)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(poly, vec![0, 32000, 64000, 96000, 128000, 160000]);
        let beats: Vec<usize> = pairs(&signal)
            .into_iter()
            .filter(|(_, v)| *v == 8.0 || *v == 4.0 || *v == 9.0 || *v == 5.0)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(beats, expected(48000, 120.0, 8));
    }

    #[test]
    fn five_against_four_places_every_poly_click_exactly() {
        let mut r = role_renderer(48000);
        r.set_poly(5);
        r.start();
        let signal = render_chunked(&mut r, 96000 * 3, 777, 1);
        let poly: Vec<usize> = pairs(&signal)
            .into_iter()
            .filter(|(_, v)| *v == 1.0 || *v == 9.0)
            .map(|(i, _)| i)
            .collect();
        let want: Vec<usize> = (0..15).map(|k| k * 19200).collect();
        assert_eq!(poly, want);
    }

    #[test]
    fn the_polyrhythm_restarts_with_every_bar() {
        let mut r = role_renderer(48000);
        r.set_beats_per_bar(3);
        r.set_poly(2);
        r.start();
        let signal = render_chunked(&mut r, 72000 * 4, 1000, 1);
        let poly: Vec<usize> = pairs(&signal)
            .into_iter()
            .filter(|(_, v)| *v == 1.0 || *v == 9.0 || *v == 5.0)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(poly, vec![0, 36000, 72000, 108000, 144000, 180000, 216000, 252000]);
    }

    #[test]
    fn subdivisions_and_polyrhythms_ignore_the_buffer_size() {
        let make = || {
            let mut r = role_renderer(48000);
            r.set_tempo(133.0);
            r.set_beats_per_bar(5);
            r.set_subdivision(3);
            r.set_poly(7);
            r.start();
            r
        };
        let reference = pairs(&render_chunked(&mut make(), 48000 * 12, 480, 1));
        for chunk in [1, 13, 64, 255, 1024, 4096] {
            let got = pairs(&render_chunked(&mut make(), 48000 * 12, chunk, 1));
            assert_eq!(got, reference, "chunk {chunk}");
        }
    }

    #[test]
    fn silent_bars_drop_the_click_for_the_chosen_number_of_bars() {
        let mut r = role_renderer(48000);
        r.set_silence(1, 2);
        r.set_subdivision(2);
        r.set_poly(3);
        r.start();
        let signal = render_chunked(&mut r, 96000 * 6, 512, 1);
        let got = onsets(&signal);
        assert!(got.iter().all(|&i| i < 96000 || (288000..384000).contains(&i)), "{got:?}");
        assert!(got.iter().any(|&i| i < 96000));
        assert!(got.iter().any(|&i| (288000..384000).contains(&i)));
        assert!(got.contains(&0));
        assert!(got.contains(&288000));
    }

    #[test]
    fn silent_bars_still_count_beats_for_the_visual_indicator() {
        let mut r = role_renderer(48000);
        r.set_silence(1, 1);
        r.start();
        let mut seen = Vec::new();
        let mut buf = vec![0.0f32; 1200];
        let mut last = 0;
        for _ in 0..(48000 * 8 / 1200) {
            r.render(&mut buf);
            if r.beat_counter() != last {
                last = r.beat_counter();
                seen.push(r.last_beat());
            }
        }
        assert_eq!(seen.len(), 16);
        assert!(!seen[0].silent && !seen[3].silent);
        assert!(seen[4].silent && seen[7].silent);
        assert!(!seen[8].silent);
        assert_eq!(seen[5].beat, 1);
        assert_eq!(seen[5].bar, 1);
        assert_eq!(seen[12].bar, 3);
    }

    #[test]
    fn accent_levels_choose_the_sound_and_loudness_of_each_beat() {
        let mut r = role_renderer(48000);
        r.set_accents(pack_accents(&[LEVEL_ACCENT, LEVEL_SOFT, LEVEL_MUTE, LEVEL_NORMAL]));
        r.start();
        let signal = render_chunked(&mut r, 48000 * 4, 256, 1);
        let got = pairs(&signal);
        assert_eq!(
            got,
            vec![(0, 8.0), (24000, 2.0), (72000, 4.0), (96000, 8.0), (120000, 2.0), (168000, 4.0)]
        );
    }

    #[test]
    fn muted_beats_still_report_to_the_visual_indicator() {
        let mut r = role_renderer(48000);
        r.set_accents(pack_accents(&[LEVEL_MUTE, LEVEL_MUTE, LEVEL_MUTE, LEVEL_MUTE]));
        r.start();
        let signal = render_chunked(&mut r, 48000 * 2, 256, 1);
        assert!(onsets(&signal).is_empty());
        assert_eq!(r.beat_counter(), 4);
        assert_eq!(r.last_beat().level, LEVEL_MUTE);
    }

    #[test]
    fn overlapping_voices_are_summed() {
        let long = || vec![1.0f32; 2000].into_boxed_slice();
        let mut r = Renderer::new(48000, 1, long(), long());
        r.set_volume(1.0);
        r.set_subdivision(8);
        r.set_sub_level(1.0);
        r.set_tempo(400.0);
        r.start();
        let signal = render_chunked(&mut r, 48000, 256, 1);
        assert!(signal.iter().all(|v| v.is_finite()));
        assert!(signal.iter().fold(0.0f32, |m, v| m.max(*v)) >= 2.0);
    }

    #[test]
    fn controls_carry_the_rich_settings_to_the_renderer() {
        let controls = Controls::new();
        controls.set_volume(1.0);
        controls.set_subdivision(2);
        controls.set_sub_level(1.0);
        controls.set_poly(0);
        controls.set_running(true);
        let mut r = role_renderer(48000);
        r.apply(&controls);
        let signal = render_chunked(&mut r, 48000 * 2, 300, 1);
        let got = pairs(&signal);
        assert_eq!(got[0], (0, 8.0));
        assert_eq!(got[1], (12000, 2.0));
        assert_eq!(got[2], (24000, 4.0));
    }

    #[test]
    fn beat_info_survives_packing() {
        let info = BeatInfo {
            beat: 5,
            bar: 123456,
            beats_per_bar: 7,
            level: LEVEL_SOFT,
            silent: true,
        };
        assert_eq!(BeatInfo::unpack(info.pack()), info);
    }

    #[test]
    fn accent_patterns_survive_packing() {
        let levels = [3u8, 1, 2, 0, 2, 2, 1];
        assert_eq!(unpack_accents(pack_accents(&levels), 7), levels.to_vec());
        assert_eq!(unpack_accents(default_accents(), 4), vec![3, 2, 2, 2]);
    }

    #[test]
    fn the_controls_publish_beats_to_a_reader_thread() {
        let controls = Controls::new();
        let info = BeatInfo {
            beat: 2,
            bar: 9,
            beats_per_bar: 4,
            level: LEVEL_NORMAL,
            silent: false,
        };
        controls.publish_beat(11, info);
        assert_eq!(controls.beat(), (11, info));
    }
}
