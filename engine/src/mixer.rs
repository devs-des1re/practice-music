use std::f32::consts::FRAC_PI_4;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::fx::{CompSettings, Compressor, Eq3, Limiter, db_to_lin};

pub const STRIPS: usize = 6;
pub const INPUT_STRIPS: usize = 4;
pub const STRIP_SONG: usize = 0;
pub const STRIP_CLICK: usize = 1;
pub const STRIP_INPUT0: usize = 2;
pub const OFF_DB: f32 = -60.0;
pub const BLOCK: usize = 1024;

pub mod sp {
    pub const GAIN: usize = 0;
    pub const PAN: usize = 1;
    pub const MUTE: usize = 2;
    pub const SOLO: usize = 3;
    pub const MAIN: usize = 4;
    pub const MONITOR: usize = 5;
    pub const EQ_LOW: usize = 6;
    pub const EQ_MID: usize = 7;
    pub const EQ_HIGH: usize = 8;
    pub const COMP_ON: usize = 9;
    pub const COMP_THRESHOLD: usize = 10;
    pub const COMP_RATIO: usize = 11;
    pub const COMP_ATTACK: usize = 12;
    pub const COMP_RELEASE: usize = 13;
    pub const COMP_MAKEUP: usize = 14;
    pub const SOURCE: usize = 15;
    pub const STEREO: usize = 16;
    pub const COUNT: usize = 17;
}

pub mod mp {
    pub const MAIN_GAIN: usize = 0;
    pub const MONITOR_GAIN: usize = 1;
    pub const LIMITER_ON: usize = 2;
    pub const CEILING: usize = 3;
    pub const MAIN_CHANNEL: usize = 4;
    pub const MONITOR_CHANNEL: usize = 5;
    pub const COUNT: usize = 6;
}

pub fn default_strip_param(strip: usize, param: usize) -> f32 {
    match param {
        sp::MAIN => {
            if strip < STRIP_INPUT0 {
                0.0
            } else {
                OFF_DB
            }
        }
        sp::MONITOR => OFF_DB,
        sp::COMP_THRESHOLD => -18.0,
        sp::COMP_RATIO => 3.0,
        sp::COMP_ATTACK => 10.0,
        sp::COMP_RELEASE => 120.0,
        sp::SOURCE => strip.saturating_sub(STRIP_INPUT0) as f32,
        _ => 0.0,
    }
}

pub fn default_master_param(param: usize) -> f32 {
    match param {
        mp::LIMITER_ON => 1.0,
        mp::CEILING => -0.3,
        _ => 0.0,
    }
}

pub struct ParamTable {
    values: Box<[AtomicU32]>,
}

impl ParamTable {
    pub fn new() -> Self {
        let mut values = Vec::with_capacity(STRIPS * sp::COUNT + mp::COUNT);
        for strip in 0..STRIPS {
            for param in 0..sp::COUNT {
                values.push(AtomicU32::new(default_strip_param(strip, param).to_bits()));
            }
        }
        for param in 0..mp::COUNT {
            values.push(AtomicU32::new(default_master_param(param).to_bits()));
        }
        Self {
            values: values.into_boxed_slice(),
        }
    }

    pub fn get(&self, strip: usize, param: usize) -> f32 {
        f32::from_bits(self.values[strip * sp::COUNT + param].load(Ordering::Relaxed))
    }

    pub fn set(&self, strip: usize, param: usize, value: f32) {
        self.values[strip * sp::COUNT + param].store(value.to_bits(), Ordering::Relaxed);
    }

    pub fn master(&self, param: usize) -> f32 {
        f32::from_bits(self.values[STRIPS * sp::COUNT + param].load(Ordering::Relaxed))
    }

    pub fn set_master(&self, param: usize, value: f32) {
        self.values[STRIPS * sp::COUNT + param].store(value.to_bits(), Ordering::Relaxed);
    }

    pub fn flag(&self, strip: usize, param: usize) -> bool {
        self.get(strip, param) >= 0.5
    }
}

impl Default for ParamTable {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Meters {
    strip_peak: [[AtomicU32; 2]; STRIPS],
    strip_clip: [AtomicBool; STRIPS],
    strip_reduction: [AtomicU32; STRIPS],
    main_peak: [AtomicU32; 2],
    monitor_peak: [AtomicU32; 2],
    main_clip: AtomicBool,
    monitor_clip: AtomicBool,
    main_reduction: AtomicU32,
    monitor_reduction: AtomicU32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Level {
    pub left: f32,
    pub right: f32,
    pub clip: bool,
    pub reduction_db: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MeterSnapshot {
    pub strips: [Level; STRIPS],
    pub main: Level,
    pub monitor: Level,
}

impl MeterSnapshot {
    pub fn is_silent(&self) -> bool {
        let quiet = |l: &Level| l.left == 0.0 && l.right == 0.0 && l.reduction_db == 0.0;
        self.strips.iter().all(quiet) && quiet(&self.main) && quiet(&self.monitor)
    }
}

fn note(slot: &AtomicU32, value: f32) {
    if value > 0.0 {
        slot.fetch_max(value.to_bits(), Ordering::Relaxed);
    }
}

fn take(slot: &AtomicU32) -> f32 {
    f32::from_bits(slot.swap(0, Ordering::Relaxed))
}

impl Meters {
    pub fn new() -> Self {
        Self {
            strip_peak: std::array::from_fn(|_| [AtomicU32::new(0), AtomicU32::new(0)]),
            strip_clip: std::array::from_fn(|_| AtomicBool::new(false)),
            strip_reduction: std::array::from_fn(|_| AtomicU32::new(0)),
            main_peak: [AtomicU32::new(0), AtomicU32::new(0)],
            monitor_peak: [AtomicU32::new(0), AtomicU32::new(0)],
            main_clip: AtomicBool::new(false),
            monitor_clip: AtomicBool::new(false),
            main_reduction: AtomicU32::new(0),
            monitor_reduction: AtomicU32::new(0),
        }
    }

    pub fn snapshot(&self) -> MeterSnapshot {
        let mut out = MeterSnapshot::default();
        for s in 0..STRIPS {
            out.strips[s] = Level {
                left: take(&self.strip_peak[s][0]),
                right: take(&self.strip_peak[s][1]),
                clip: self.strip_clip[s].load(Ordering::Relaxed),
                reduction_db: take(&self.strip_reduction[s]),
            };
        }
        out.main = Level {
            left: take(&self.main_peak[0]),
            right: take(&self.main_peak[1]),
            clip: self.main_clip.load(Ordering::Relaxed),
            reduction_db: take(&self.main_reduction),
        };
        out.monitor = Level {
            left: take(&self.monitor_peak[0]),
            right: take(&self.monitor_peak[1]),
            clip: self.monitor_clip.load(Ordering::Relaxed),
            reduction_db: take(&self.monitor_reduction),
        };
        out
    }

    pub fn reset_clips(&self) {
        for clip in &self.strip_clip {
            clip.store(false, Ordering::Relaxed);
        }
        self.main_clip.store(false, Ordering::Relaxed);
        self.monitor_clip.store(false, Ordering::Relaxed);
    }
}

impl Default for Meters {
    fn default() -> Self {
        Self::new()
    }
}

pub fn pan_gains(pan: f32, balance: bool) -> (f32, f32) {
    let p = pan.clamp(-1.0, 1.0);
    if balance {
        ((1.0 - p).min(1.0), (1.0 + p).min(1.0))
    } else {
        let angle = (p + 1.0) * FRAC_PI_4;
        (angle.cos(), angle.sin())
    }
}

fn send_gain(db: f32) -> f32 {
    if db <= OFF_DB { 0.0 } else { db_to_lin(db) }
}

struct StripDsp {
    eq: Eq3,
    comp: Compressor,
    left: f32,
    right: f32,
    to_main: f32,
    to_monitor: f32,
    primed: bool,
}

pub struct Mixer {
    strips: [StripDsp; STRIPS],
    main_limiter: Limiter,
    monitor_limiter: Limiter,
    main_gain: f32,
    monitor_gain: f32,
    master_primed: bool,
    smooth: f32,
}

fn peak_of(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

impl Mixer {
    pub fn new(rate: u32) -> Self {
        Self {
            strips: std::array::from_fn(|_| StripDsp {
                eq: Eq3::new(rate),
                comp: Compressor::new(rate),
                left: 0.0,
                right: 0.0,
                to_main: 0.0,
                to_monitor: 0.0,
                primed: false,
            }),
            main_limiter: Limiter::new(rate),
            monitor_limiter: Limiter::new(rate),
            main_gain: 1.0,
            monitor_gain: 1.0,
            master_primed: false,
            smooth: 1.0 - (-1.0 / (0.005 * rate as f32)).exp(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        params: &ParamTable,
        meters: &Meters,
        inputs: &mut [Vec<f32>; STRIPS],
        frames: usize,
        main: &mut [f32],
        monitor: &mut [f32],
        monitor_active: bool,
    ) {
        let samples = frames * 2;
        let main = &mut main[..samples];
        let monitor = &mut monitor[..samples];
        main.fill(0.0);
        monitor.fill(0.0);
        let any_solo = (0..STRIPS).any(|s| params.flag(s, sp::SOLO));
        let k = self.smooth;
        for (s, strip) in self.strips.iter_mut().enumerate() {
            let buf = &mut inputs[s][..samples];
            let source_peak = peak_of(buf);
            strip.eq.set_gains(
                params.get(s, sp::EQ_LOW),
                params.get(s, sp::EQ_MID),
                params.get(s, sp::EQ_HIGH),
            );
            strip.eq.process_stereo(buf);
            let comp = CompSettings {
                enabled: params.flag(s, sp::COMP_ON),
                threshold_db: params.get(s, sp::COMP_THRESHOLD),
                ratio: params.get(s, sp::COMP_RATIO),
                attack_ms: params.get(s, sp::COMP_ATTACK),
                release_ms: params.get(s, sp::COMP_RELEASE),
                makeup_db: params.get(s, sp::COMP_MAKEUP),
            };
            let reduction = strip.comp.process_stereo(buf, &comp);
            let audible = !params.flag(s, sp::MUTE) && (!any_solo || params.flag(s, sp::SOLO));
            let fader = if audible { db_to_lin(params.get(s, sp::GAIN)) } else { 0.0 };
            let balance = s < STRIP_INPUT0 || params.flag(s, sp::STEREO);
            let (pan_l, pan_r) = pan_gains(params.get(s, sp::PAN), balance);
            let target_l = fader * pan_l;
            let target_r = fader * pan_r;
            let target_main = send_gain(params.get(s, sp::MAIN));
            let target_monitor = if monitor_active { send_gain(params.get(s, sp::MONITOR)) } else { 0.0 };
            if !strip.primed {
                strip.left = target_l;
                strip.right = target_r;
                strip.to_main = target_main;
                strip.to_monitor = target_monitor;
                strip.primed = true;
            }
            let mut peak_l = 0.0f32;
            let mut peak_r = 0.0f32;
            for f in 0..frames {
                strip.left += (target_l - strip.left) * k;
                strip.right += (target_r - strip.right) * k;
                strip.to_main += (target_main - strip.to_main) * k;
                strip.to_monitor += (target_monitor - strip.to_monitor) * k;
                let l = buf[f * 2] * strip.left;
                let r = buf[f * 2 + 1] * strip.right;
                peak_l = peak_l.max(l.abs());
                peak_r = peak_r.max(r.abs());
                main[f * 2] += l * strip.to_main;
                main[f * 2 + 1] += r * strip.to_main;
                monitor[f * 2] += l * strip.to_monitor;
                monitor[f * 2 + 1] += r * strip.to_monitor;
            }
            note(&meters.strip_peak[s][0], peak_l);
            note(&meters.strip_peak[s][1], peak_r);
            note(&meters.strip_reduction[s], reduction);
            if source_peak >= 0.999 || peak_l >= 1.0 || peak_r >= 1.0 {
                meters.strip_clip[s].store(true, Ordering::Relaxed);
            }
        }
        let main_target = db_to_lin(params.master(mp::MAIN_GAIN));
        let monitor_target = db_to_lin(params.master(mp::MONITOR_GAIN));
        if !self.master_primed {
            self.main_gain = main_target;
            self.monitor_gain = monitor_target;
            self.master_primed = true;
        }
        for f in 0..frames {
            self.main_gain += (main_target - self.main_gain) * k;
            self.monitor_gain += (monitor_target - self.monitor_gain) * k;
            main[f * 2] *= self.main_gain;
            main[f * 2 + 1] *= self.main_gain;
            monitor[f * 2] *= self.monitor_gain;
            monitor[f * 2 + 1] *= self.monitor_gain;
        }
        if params.flag_master(mp::LIMITER_ON) {
            let ceiling = db_to_lin(params.master(mp::CEILING)).clamp(0.05, 1.0);
            let main_gr = self.main_limiter.process_stereo(main, ceiling);
            note(&meters.main_reduction, main_gr);
            if monitor_active {
                let monitor_gr = self.monitor_limiter.process_stereo(monitor, ceiling);
                note(&meters.monitor_reduction, monitor_gr);
            }
        }
        let (main_l, main_r) = stereo_peaks(main);
        note(&meters.main_peak[0], main_l);
        note(&meters.main_peak[1], main_r);
        if main_l >= 1.0 || main_r >= 1.0 {
            meters.main_clip.store(true, Ordering::Relaxed);
        }
        if monitor_active {
            let (mon_l, mon_r) = stereo_peaks(monitor);
            note(&meters.monitor_peak[0], mon_l);
            note(&meters.monitor_peak[1], mon_r);
            if mon_l >= 1.0 || mon_r >= 1.0 {
                meters.monitor_clip.store(true, Ordering::Relaxed);
            }
        }
    }
}

impl ParamTable {
    pub fn flag_master(&self, param: usize) -> bool {
        self.master(param) >= 0.5
    }
}

fn stereo_peaks(buf: &[f32]) -> (f32, f32) {
    let mut l = 0.0f32;
    let mut r = 0.0f32;
    for frame in buf.as_chunks::<2>().0.iter() {
        l = l.max(frame[0].abs());
        r = r.max(frame[1].abs());
    }
    (l, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48000;

    fn rig() -> (Mixer, ParamTable, Meters, [Vec<f32>; STRIPS]) {
        (
            Mixer::new(RATE),
            ParamTable::new(),
            Meters::new(),
            std::array::from_fn(|_| vec![0.0f32; BLOCK * 2]),
        )
    }

    fn fill(buf: &mut [f32], l: f32, r: f32) {
        for frame in buf.as_chunks_mut::<2>().0.iter_mut() {
            frame[0] = l;
            frame[1] = r;
        }
    }

    struct Out {
        main: Vec<f32>,
        monitor: Vec<f32>,
    }

    fn run(
        mixer: &mut Mixer,
        params: &ParamTable,
        meters: &Meters,
        inputs: &mut [Vec<f32>; STRIPS],
        frames: usize,
        monitor_active: bool,
    ) -> Out {
        let mut all_main = Vec::new();
        let mut all_monitor = Vec::new();
        let mut done = 0;
        while done < frames {
            let n = BLOCK.min(frames - done);
            let mut main = vec![0.0f32; BLOCK * 2];
            let mut monitor = vec![0.0f32; BLOCK * 2];
            mixer.process(params, meters, inputs, n, &mut main, &mut monitor, monitor_active);
            all_main.extend_from_slice(&main[..n * 2]);
            all_monitor.extend_from_slice(&monitor[..n * 2]);
            done += n;
        }
        Out {
            main: all_main,
            monitor: all_monitor,
        }
    }

    fn last(out: &[f32]) -> (f32, f32) {
        (out[out.len() - 2], out[out.len() - 1])
    }

    #[test]
    fn the_default_mixer_passes_the_song_and_click_to_the_main_bus_only() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.4, 0.2);
        fill(&mut inputs[STRIP_CLICK], 0.1, 0.1);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 256, true);
        let (l, r) = last(&out.main);
        assert!((l - 0.5).abs() < 1e-5 && (r - 0.3).abs() < 1e-5, "{l} {r}");
        assert!(out.monitor.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn input_strips_are_off_the_main_bus_until_routed() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_INPUT0], 0.5, 0.5);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 128, true);
        assert!(out.main.iter().all(|v| *v == 0.0));
        params.set(STRIP_INPUT0, sp::MAIN, 0.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 1000, true);
        assert!(last(&out.main).0 > 0.3);
    }

    #[test]
    fn the_fader_scales_in_decibels() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.5, 0.5);
        params.set(STRIP_SONG, sp::GAIN, -6.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 512, false);
        let (l, _) = last(&out.main);
        assert!((l - 0.5 * db_to_lin(-6.0)).abs() < 1e-3, "{l}");
    }

    #[test]
    fn mute_silences_a_strip_and_solo_isolates_one() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.3, 0.3);
        fill(&mut inputs[STRIP_CLICK], 0.2, 0.2);
        params.set(STRIP_SONG, sp::MUTE, 1.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 4000, false);
        assert!((last(&out.main).0 - 0.2).abs() < 1e-3);
        params.set(STRIP_SONG, sp::MUTE, 0.0);
        params.set(STRIP_CLICK, sp::SOLO, 1.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 4000, false);
        assert!((last(&out.main).0 - 0.2).abs() < 1e-3);
        params.set(STRIP_SONG, sp::SOLO, 1.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 4000, false);
        assert!((last(&out.main).0 - 0.5).abs() < 1e-3);
    }

    #[test]
    fn a_muted_strip_also_stays_out_of_the_monitor_mix() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.3, 0.3);
        params.set(STRIP_SONG, sp::MONITOR, 0.0);
        params.set(STRIP_SONG, sp::MUTE, 1.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 1000, true);
        assert!(last(&out.monitor).0.abs() < 1e-4);
    }

    #[test]
    fn mono_inputs_use_a_constant_power_pan_law() {
        let (mut mixer, params, meters, mut inputs) = rig();
        params.set(STRIP_INPUT0, sp::MAIN, 0.0);
        fill(&mut inputs[STRIP_INPUT0], 0.5, 0.5);
        let center = last(&run(&mut mixer, &params, &meters, &mut inputs, 256, false).main);
        assert!((center.0 - 0.3536).abs() < 1e-3 && (center.1 - 0.3536).abs() < 1e-3);
        params.set(STRIP_INPUT0, sp::PAN, -1.0);
        let left = last(&run(&mut mixer, &params, &meters, &mut inputs, 2000, false).main);
        assert!((left.0 - 0.5).abs() < 1e-2 && left.1.abs() < 1e-2, "{left:?}");
        params.set(STRIP_INPUT0, sp::PAN, 1.0);
        let right = last(&run(&mut mixer, &params, &meters, &mut inputs, 2000, false).main);
        assert!(right.0.abs() < 1e-2 && (right.1 - 0.5).abs() < 1e-2);
    }

    #[test]
    fn stereo_strips_use_a_balance_law_that_keeps_the_centre_at_unity() {
        assert_eq!(pan_gains(0.0, true), (1.0, 1.0));
        assert_eq!(pan_gains(-1.0, true), (1.0, 0.0));
        assert_eq!(pan_gains(0.5, true), (0.5, 1.0));
        let (l, r) = pan_gains(0.0, false);
        assert!((l * l + r * r - 1.0).abs() < 1e-5);
    }

    #[test]
    fn sends_route_a_strip_to_the_monitor_bus_when_one_is_active() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_CLICK], 0.4, 0.4);
        params.set(STRIP_CLICK, sp::MAIN, OFF_DB);
        params.set(STRIP_CLICK, sp::MONITOR, -6.0);
        let on = run(&mut mixer, &params, &meters, &mut inputs, 2000, true);
        assert!(last(&on.main).0.abs() < 1e-4);
        assert!((last(&on.monitor).0 - 0.4 * db_to_lin(-6.0)).abs() < 1e-3);
        let off = run(&mut mixer, &params, &meters, &mut inputs, 2000, false);
        assert!(last(&off.monitor).0.abs() < 1e-4);
    }

    #[test]
    fn the_master_gain_applies_to_each_bus_separately() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.4, 0.4);
        params.set(STRIP_SONG, sp::MONITOR, 0.0);
        params.set_master(mp::MAIN_GAIN, -6.0);
        params.set_master(mp::MONITOR_GAIN, 0.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 4000, true);
        assert!((last(&out.main).0 - 0.4 * db_to_lin(-6.0)).abs() < 1e-3);
        assert!((last(&out.monitor).0 - 0.4).abs() < 1e-3);
    }

    #[test]
    fn the_master_limiter_holds_the_output_under_the_ceiling() {
        let (mut mixer, params, meters, mut inputs) = rig();
        for input in inputs.iter_mut() {
            fill(input, 0.9, -0.9);
        }
        for s in STRIP_INPUT0..STRIPS {
            params.set(s, sp::MAIN, 0.0);
        }
        let ceiling = db_to_lin(-0.3);
        for _ in 0..8 {
            let out = run(&mut mixer, &params, &meters, &mut inputs, BLOCK, false);
            assert!(out.main.iter().all(|v| v.abs() <= ceiling + 1e-6));
        }
        assert!(meters.snapshot().main.reduction_db > 3.0);
    }

    #[test]
    fn with_the_limiter_off_the_master_is_allowed_to_clip_and_says_so() {
        let (mut mixer, params, meters, mut inputs) = rig();
        params.set_master(mp::LIMITER_ON, 0.0);
        fill(&mut inputs[STRIP_SONG], 0.9, 0.9);
        fill(&mut inputs[STRIP_CLICK], 0.9, 0.9);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 512, false);
        assert!(last(&out.main).0 > 1.5);
        assert!(meters.snapshot().main.clip);
    }

    #[test]
    fn meters_report_peaks_since_the_last_read_and_clear_them() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.25, 0.5);
        run(&mut mixer, &params, &meters, &mut inputs, 512, false);
        let first = meters.snapshot();
        assert!((first.strips[STRIP_SONG].left - 0.25).abs() < 1e-3);
        assert!((first.strips[STRIP_SONG].right - 0.5).abs() < 1e-3);
        assert!(first.main.left > 0.2);
        let second = meters.snapshot();
        assert_eq!(second.strips[STRIP_SONG].left, 0.0);
        assert!(second.is_silent());
    }

    #[test]
    fn a_hot_input_latches_its_clip_light_until_it_is_reset() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_INPUT0], 1.0, 1.0);
        run(&mut mixer, &params, &meters, &mut inputs, 64, false);
        assert!(meters.snapshot().strips[STRIP_INPUT0].clip);
        fill(&mut inputs[STRIP_INPUT0], 0.1, 0.1);
        run(&mut mixer, &params, &meters, &mut inputs, 64, false);
        assert!(meters.snapshot().strips[STRIP_INPUT0].clip);
        meters.reset_clips();
        run(&mut mixer, &params, &meters, &mut inputs, 64, false);
        assert!(!meters.snapshot().strips[STRIP_INPUT0].clip);
    }

    #[test]
    fn fader_moves_are_smoothed_instead_of_stepping() {
        let (mut mixer, params, meters, mut inputs) = rig();
        fill(&mut inputs[STRIP_SONG], 0.5, 0.5);
        run(&mut mixer, &params, &meters, &mut inputs, 512, false);
        params.set(STRIP_SONG, sp::GAIN, -40.0);
        let out = run(&mut mixer, &params, &meters, &mut inputs, 1000, false);
        let biggest = out.main.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(biggest < 0.01, "step {biggest}");
        assert!(last(&out.main).0 < 0.02);
    }

    #[test]
    fn eq_and_compression_run_inside_the_strip() {
        let (mut mixer, params, meters, mut inputs) = rig();
        params.set(STRIP_SONG, sp::COMP_ON, 1.0);
        params.set(STRIP_SONG, sp::COMP_THRESHOLD, -30.0);
        params.set(STRIP_SONG, sp::COMP_RATIO, 8.0);
        params.set(STRIP_SONG, sp::COMP_ATTACK, 0.5);
        fill(&mut inputs[STRIP_SONG], 0.5, 0.5);
        let mut out = run(&mut mixer, &params, &meters, &mut inputs, BLOCK, false);
        for _ in 0..10 {
            fill(&mut inputs[STRIP_SONG], 0.5, 0.5);
            out = run(&mut mixer, &params, &meters, &mut inputs, BLOCK, false);
        }
        assert!(last(&out.main).0 < 0.2);
        assert!(meters.snapshot().strips[STRIP_SONG].reduction_db > 5.0);
    }

    #[test]
    fn output_does_not_depend_on_the_block_size() {
        let render = |block: usize| {
            let (mut mixer, params, meters, mut inputs) = rig();
            params.set(STRIP_SONG, sp::EQ_LOW, 6.0);
            params.set(STRIP_SONG, sp::PAN, 0.3);
            params.set(STRIP_CLICK, sp::GAIN, -3.0);
            let mut all = Vec::new();
            let mut t = 0usize;
            while t < 4000 {
                let n = block.min(4000 - t);
                for f in 0..n {
                    let v = (((t + f) as f32) * 0.05).sin() * 0.4;
                    inputs[STRIP_SONG][f * 2] = v;
                    inputs[STRIP_SONG][f * 2 + 1] = -v;
                    inputs[STRIP_CLICK][f * 2] = v * 0.5;
                    inputs[STRIP_CLICK][f * 2 + 1] = v * 0.5;
                }
                all.extend(run(&mut mixer, &params, &meters, &mut inputs, n, false).main);
                t += n;
            }
            all
        };
        let reference = render(1000);
        for block in [1, 17, 128, 512] {
            let got = render(block);
            let worst = got.iter().zip(&reference).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
            assert!(worst < 1e-5, "block {block} differs by {worst}");
        }
    }

    #[test]
    fn the_parameter_table_starts_with_safe_defaults() {
        let params = ParamTable::new();
        assert_eq!(params.get(STRIP_SONG, sp::MAIN), 0.0);
        assert_eq!(params.get(STRIP_SONG, sp::MONITOR), OFF_DB);
        assert_eq!(params.get(STRIP_INPUT0, sp::MAIN), OFF_DB);
        assert_eq!(params.get(STRIP_INPUT0 + 3, sp::SOURCE), 3.0);
        assert!(params.flag_master(mp::LIMITER_ON));
        params.set(2, sp::PAN, -0.5);
        assert_eq!(params.get(2, sp::PAN), -0.5);
        params.set_master(mp::MONITOR_CHANNEL, 2.0);
        assert_eq!(params.master(mp::MONITOR_CHANNEL), 2.0);
    }
}
