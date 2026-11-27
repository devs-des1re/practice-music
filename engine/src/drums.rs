use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use crate::fx::db_to_lin;
use crate::midi::Message;

pub const MAX_PADS: usize = 24;
const VOICES: usize = 64;
const MAX_LAYERS: usize = 64;
const NO_PAD: u8 = 255;
const CHOKE_SECONDS: f32 = 0.03;
const DYNAMIC_RANGE_DB: f32 = 9.0;
const GRAB_PRESSURE: u8 = 64;

pub struct Sample {
    pub data: Box<[i16]>,
    pub scale: f32,
}

impl Sample {
    pub fn frames(&self) -> usize {
        self.data.len() / 2
    }
}

pub struct Layer {
    pub takes: Vec<Arc<Sample>>,
}

#[derive(Default)]
pub struct Sound {
    pub layers: Vec<Layer>,
}

pub struct Kit {
    pub rate: u32,
    pub pads: Vec<Sound>,
}

impl Kit {
    pub fn bytes(&self) -> usize {
        self.pads
            .iter()
            .flat_map(|p| p.layers.iter())
            .flat_map(|l| l.takes.iter())
            .map(|s| s.data.len() * 2)
            .sum()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PadConfig {
    pub gain_db: f32,
    pub pan: f32,
    pub tune: f32,
    pub choke: u8,
    pub sensitivity: f32,
}

impl Default for PadConfig {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            pan: 0.0,
            tune: 0.0,
            choke: 0,
            sensitivity: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pedal {
    pub threshold: u8,
    pub reversed: bool,
    pub open_pad: u8,
    pub closed_pad: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub notes: [u8; 128],
    pub pads: [PadConfig; MAX_PADS],
    pub curve: f32,
    pub threshold: u8,
    pub pedal: Option<Pedal>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            notes: [NO_PAD; 128],
            pads: [PadConfig::default(); MAX_PADS],
            curve: 1.0,
            threshold: 1,
            pedal: None,
        }
    }
}

impl Config {
    pub fn assign(&mut self, note: u8, pad: usize) {
        if note < 128 && pad < MAX_PADS {
            self.notes[usize::from(note)] = pad as u8;
        }
    }

    pub fn pad_for(&self, note: u8) -> Option<usize> {
        self.notes
            .get(usize::from(note))
            .copied()
            .filter(|pad| *pad != NO_PAD)
            .map(usize::from)
    }
}

pub enum DrumCommand {
    Midi(Message),
    Trigger { pad: usize, velocity: u8 },
    Kit(Arc<Kit>),
    Config(Arc<Config>),
}

#[derive(Default)]
struct HubState {
    sender: Option<Sender<DrumCommand>>,
    rate: u32,
    kit: Option<Arc<Kit>>,
    config: Option<Arc<Config>>,
    retired_kit: Option<Arc<Kit>>,
    retired_configs: Vec<Arc<Config>>,
}

const RETIRED: usize = 3;

#[derive(Default)]
pub struct Hub {
    state: Mutex<HubState>,
}

impl Hub {
    pub fn attach(&self, sender: Sender<DrumCommand>, rate: u32) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(config) = &state.config {
                let _ = sender.send(DrumCommand::Config(Arc::clone(config)));
            }
            if let Some(kit) = state.kit.as_ref().filter(|kit| kit.rate == rate) {
                let _ = sender.send(DrumCommand::Kit(Arc::clone(kit)));
            }
            state.sender = Some(sender);
            state.rate = rate;
        }
    }

    pub fn detach(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.sender = None;
        }
    }

    pub fn rate(&self) -> Option<u32> {
        let state = self.state.lock().ok()?;
        state.sender.as_ref().map(|_| state.rate)
    }

    pub fn send(&self, command: DrumCommand) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        state
            .sender
            .as_ref()
            .is_some_and(|sender| sender.send(command).is_ok())
    }

    pub fn set_kit(&self, kit: Arc<Kit>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(sender) = &state.sender
                && kit.rate == state.rate
            {
                let _ = sender.send(DrumCommand::Kit(Arc::clone(&kit)));
            }
            let old = state.kit.replace(kit);
            state.retired_kit = old;
        }
    }

    pub fn release_retired_kit(&self) {
        let old = match self.state.lock() {
            Ok(mut state) => state.retired_kit.take(),
            Err(_) => None,
        };
        drop(old);
    }

    pub fn set_config(&self, config: Arc<Config>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(sender) = &state.sender {
                let _ = sender.send(DrumCommand::Config(Arc::clone(&config)));
            }
            if let Some(old) = state.config.replace(config) {
                state.retired_configs.push(old);
                if state.retired_configs.len() > RETIRED {
                    state.retired_configs.remove(0);
                }
            }
        }
    }
}

#[derive(Default)]
struct Voice {
    sample: Option<Arc<Sample>>,
    pad: usize,
    group: u8,
    position: f64,
    step: f64,
    left: f32,
    right: f32,
    fade: f32,
    fade_step: f32,
    born: u64,
}

pub struct Sampler {
    voices: [Voice; VOICES],
    kit: Option<Arc<Kit>>,
    config: Option<Arc<Config>>,
    turns: [[u16; MAX_LAYERS]; MAX_PADS],
    pedal_value: u8,
    fade_step: f32,
    clock: u64,
}

pub fn shape_velocity(velocity: u8, curve: f32) -> f32 {
    (f32::from(velocity.min(127)) / 127.0).powf(curve.clamp(0.25, 4.0))
}

pub fn layer_for(shaped: f32, layers: usize) -> usize {
    ((shaped * layers as f32) as usize).min(layers.saturating_sub(1))
}

impl Sampler {
    pub fn new(rate: u32) -> Self {
        Self {
            voices: std::array::from_fn(|_| Voice::default()),
            kit: None,
            config: None,
            turns: [[0; MAX_LAYERS]; MAX_PADS],
            pedal_value: 0,
            fade_step: 1.0 / (CHOKE_SECONDS * rate as f32),
            clock: 0,
        }
    }

    pub fn apply(&mut self, command: DrumCommand) {
        match command {
            DrumCommand::Midi(message) => self.midi(message),
            DrumCommand::Trigger { pad, velocity } => self.strike(pad, velocity),
            DrumCommand::Kit(kit) => self.kit = Some(kit),
            DrumCommand::Config(config) => {
                if !config.enabled {
                    self.silence();
                }
                self.config = Some(config);
            }
        }
    }

    fn midi(&mut self, message: Message) {
        let Some(config) = self.config.as_deref() else {
            return;
        };
        if !config.enabled {
            return;
        }
        match message {
            Message::Hit { note, velocity } => {
                if velocity < config.threshold {
                    return;
                }
                let Some(mut pad) = config.pad_for(note) else {
                    return;
                };
                if let Some(pedal) = config.pedal
                    && (pad == usize::from(pedal.open_pad) || pad == usize::from(pedal.closed_pad))
                {
                    let pressed = if pedal.reversed {
                        127 - self.pedal_value
                    } else {
                        self.pedal_value
                    };
                    pad = usize::from(if pressed >= pedal.threshold {
                        pedal.closed_pad
                    } else {
                        pedal.open_pad
                    });
                }
                self.strike(pad, velocity);
            }
            Message::Grab { note, pressure } => {
                if pressure >= GRAB_PRESSURE
                    && let Some(pad) = config.pad_for(note)
                {
                    self.choke_pad(pad);
                }
            }
            Message::Pedal { value } => self.pedal_value = value,
            Message::Release { .. } => {}
        }
    }

    pub fn strike(&mut self, pad: usize, velocity: u8) {
        if pad >= MAX_PADS || velocity == 0 {
            return;
        }
        let (Some(kit), Some(config)) = (self.kit.as_ref(), self.config.as_ref()) else {
            return;
        };
        let Some(sound) = kit.pads.get(pad).filter(|s| !s.layers.is_empty()) else {
            return;
        };
        let setting = config.pads[pad];
        let felt = (f32::from(velocity) * setting.sensitivity.clamp(0.25, 4.0))
            .round()
            .clamp(1.0, 127.0) as u8;
        let shaped = shape_velocity(felt, config.curve);
        let layer = layer_for(shaped, sound.layers.len().min(MAX_LAYERS));
        let takes = &sound.layers[layer].takes;
        if takes.is_empty() {
            return;
        }
        let turn = &mut self.turns[pad][layer];
        let sample = Arc::clone(&takes[usize::from(*turn) % takes.len()]);
        *turn = turn.wrapping_add(1);
        let gain = db_to_lin(setting.gain_db - (1.0 - shaped) * DYNAMIC_RANGE_DB);
        let pan = setting.pan.clamp(-1.0, 1.0);
        if setting.choke > 0 {
            let step = self.fade_step;
            for voice in self.voices.iter_mut() {
                if voice.sample.is_some() && voice.group == setting.choke {
                    voice.fade_step = step;
                }
            }
        }
        self.clock += 1;
        let born = self.clock;
        let slot = self
            .voices
            .iter()
            .position(|v| v.sample.is_none())
            .or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.born)
                    .map(|(i, _)| i)
            })
            .unwrap_or(0);
        self.voices[slot] = Voice {
            sample: Some(sample),
            pad,
            group: setting.choke,
            position: 0.0,
            step: f64::from(2.0f32.powf(setting.tune.clamp(-12.0, 12.0) / 12.0)),
            left: gain * (1.0 - pan).min(1.0),
            right: gain * (1.0 + pan).min(1.0),
            fade: 1.0,
            fade_step: 0.0,
            born,
        };
    }

    pub fn choke_pad(&mut self, pad: usize) {
        for voice in self.voices.iter_mut() {
            if voice.sample.is_some() && voice.pad == pad {
                voice.fade_step = self.fade_step;
            }
        }
    }

    pub fn silence(&mut self) {
        for voice in self.voices.iter_mut() {
            if voice.sample.is_some() {
                voice.fade_step = self.fade_step;
            }
        }
    }

    #[cfg(test)]
    pub fn sounding(&self) -> usize {
        self.voices.iter().filter(|v| v.sample.is_some()).count()
    }

    pub fn render(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        let frames = out.len() / 2;
        for voice in self.voices.iter_mut() {
            let Some(sample) = voice.sample.as_deref() else {
                continue;
            };
            let length = sample.frames();
            let mut finished = false;
            for frame in 0..frames {
                let index = voice.position as usize;
                if index + 1 >= length || voice.fade <= 0.0 {
                    finished = true;
                    break;
                }
                let part = (voice.position - index as f64) as f32;
                let level = sample.scale * voice.fade;
                let left = f32::from(sample.data[index * 2]) * (1.0 - part)
                    + f32::from(sample.data[index * 2 + 2]) * part;
                let right = f32::from(sample.data[index * 2 + 1]) * (1.0 - part)
                    + f32::from(sample.data[index * 2 + 3]) * part;
                out[frame * 2] += left * level * voice.left;
                out[frame * 2 + 1] += right * level * voice.right;
                voice.position += voice.step;
                voice.fade -= voice.fade_step;
            }
            if finished {
                voice.sample = None;
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn flat(level: i16, frames: usize) -> Arc<Sample> {
        Arc::new(Sample {
            data: vec![level; frames * 2].into_boxed_slice(),
            scale: 1.0 / 1000.0,
        })
    }

    fn kit() -> Arc<Kit> {
        let layered = Sound {
            layers: vec![
                Layer {
                    takes: vec![flat(100, 4000)],
                },
                Layer {
                    takes: vec![flat(300, 4000), flat(500, 4000)],
                },
            ],
        };
        let one = |level| Sound {
            layers: vec![Layer {
                takes: vec![flat(level, 48000)],
            }],
        };
        Arc::new(Kit {
            rate: 48000,
            pads: vec![layered, one(200), one(400)],
        })
    }

    fn config() -> Config {
        let mut c = Config {
            enabled: true,
            ..Config::default()
        };
        c.assign(38, 0);
        c.assign(46, 1);
        c.assign(42, 2);
        c.pads[1].choke = 1;
        c.pads[2].choke = 1;
        c
    }

    fn rig(config: Config) -> Sampler {
        let mut s = Sampler::new(48000);
        s.apply(DrumCommand::Kit(kit()));
        s.apply(DrumCommand::Config(Arc::new(config)));
        s
    }

    fn first(s: &mut Sampler) -> (f32, f32) {
        let mut out = vec![0.0f32; 2];
        s.render(&mut out);
        (out[0], out[1])
    }

    fn hit(s: &mut Sampler, note: u8, velocity: u8) {
        s.apply(DrumCommand::Midi(Message::Hit { note, velocity }));
    }

    fn near(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.002
    }

    fn level_of_a_hit(s: &mut Sampler, velocity: u8) -> f32 {
        hit(s, 38, velocity);
        let mut out = vec![0.0f32; 4001 * 2];
        s.render(&mut out);
        out[0]
    }

    #[test]
    fn harder_hits_use_louder_recordings_and_takes_alternate() {
        let mut s = rig(config());
        let soft = level_of_a_hit(&mut s, 40);
        let expected = 0.1 * db_to_lin(-(1.0 - 40.0 / 127.0) * 9.0);
        assert!(near(soft, expected), "{soft}");
        let heard: Vec<f32> = (0..3).map(|_| level_of_a_hit(&mut s, 127)).collect();
        assert!(
            near(heard[0], 0.3) && near(heard[1], 0.5) && near(heard[2], 0.3),
            "{heard:?}"
        );
    }

    #[test]
    fn a_more_sensitive_pad_reaches_the_hard_layer_with_a_lighter_hit() {
        let mut c = config();
        c.pads[0].sensitivity = 2.0;
        let mut s = rig(c);
        let heard = level_of_a_hit(&mut s, 64);
        assert!(near(heard, 0.3), "{heard}");
    }

    #[test]
    fn the_curve_makes_light_hits_reach_louder_layers() {
        assert_eq!(layer_for(shape_velocity(40, 1.0), 4), 1);
        assert_eq!(layer_for(shape_velocity(40, 0.5), 4), 2);
        assert_eq!(layer_for(shape_velocity(40, 2.0), 4), 0);
        assert_eq!(layer_for(shape_velocity(127, 2.0), 4), 3);
    }

    #[test]
    fn light_touches_under_the_threshold_are_ignored() {
        let mut c = config();
        c.threshold = 12;
        let mut s = rig(c);
        hit(&mut s, 38, 11);
        assert_eq!(s.sounding(), 0);
        hit(&mut s, 38, 12);
        assert_eq!(s.sounding(), 1);
    }

    #[test]
    fn an_unmapped_note_or_a_switched_off_kit_is_silent() {
        let mut s = rig(config());
        hit(&mut s, 99, 100);
        assert_eq!(s.sounding(), 0);
        let mut off = config();
        off.enabled = false;
        let mut s = rig(off);
        hit(&mut s, 38, 100);
        assert_eq!(s.sounding(), 0);
    }

    #[test]
    fn a_closed_hi_hat_cuts_the_open_one_within_thirty_milliseconds() {
        let mut s = rig(config());
        hit(&mut s, 46, 127);
        let mut out = vec![0.0f32; 128 * 2];
        s.render(&mut out);
        hit(&mut s, 42, 127);
        assert_eq!(s.sounding(), 2);
        let mut tail = vec![0.0f32; 1600 * 2];
        s.render(&mut tail);
        assert_eq!(s.sounding(), 1);
        assert!(near(tail[tail.len() - 2], 0.4));
    }

    #[test]
    fn grabbing_a_cymbal_stops_it() {
        let mut s = rig(config());
        hit(&mut s, 38, 127);
        s.apply(DrumCommand::Midi(Message::Grab {
            note: 38,
            pressure: 127,
        }));
        let mut out = vec![0.0f32; 1600 * 2];
        s.render(&mut out);
        assert_eq!(s.sounding(), 0);
    }

    #[test]
    fn the_pedal_can_choose_between_open_and_closed() {
        let mut c = config();
        c.pedal = Some(Pedal {
            threshold: 80,
            reversed: false,
            open_pad: 1,
            closed_pad: 2,
        });
        let mut s = rig(c.clone());
        s.apply(DrumCommand::Midi(Message::Pedal { value: 110 }));
        hit(&mut s, 46, 127);
        assert!(near(first(&mut s).0, 0.4), "pedal down plays closed");
        c.pedal = Some(Pedal {
            reversed: true,
            ..c.pedal.unwrap()
        });
        let mut s = rig(c);
        s.apply(DrumCommand::Midi(Message::Pedal { value: 110 }));
        hit(&mut s, 42, 127);
        assert!(near(first(&mut s).0, 0.2), "reversed pedal reads as up");
    }

    #[test]
    fn volume_pan_and_tune_apply_per_pad() {
        let mut c = config();
        c.pads[1].gain_db = -6.0;
        c.pads[1].pan = 1.0;
        let mut s = rig(c);
        hit(&mut s, 46, 127);
        let (l, r) = first(&mut s);
        assert!(l.abs() < 1e-6 && near(r, 0.2 * db_to_lin(-6.0)));
        let mut tuned = config();
        tuned.pads[0].tune = 12.0;
        let mut s = rig(tuned);
        hit(&mut s, 38, 10);
        let mut out = vec![0.0f32; 2001 * 2];
        s.render(&mut out);
        assert_eq!(s.sounding(), 0, "an octave up plays in half the time");
    }

    #[test]
    fn many_hits_reuse_the_oldest_voice() {
        let mut c = config();
        c.pads[1].choke = 0;
        let mut s = rig(c);
        for _ in 0..200 {
            hit(&mut s, 46, 100);
        }
        assert_eq!(s.sounding(), VOICES);
    }

    #[test]
    fn a_replaced_kit_is_freed_once_the_stream_has_had_time_to_switch() {
        let hub = Hub::default();
        let first = kit();
        let watch = Arc::downgrade(&first);
        hub.set_kit(first);
        hub.set_kit(kit());
        assert!(watch.upgrade().is_some(), "not freed on the swap itself");
        hub.release_retired_kit();
        assert!(watch.upgrade().is_none());
    }

    #[test]
    fn the_hub_replays_the_kit_and_settings_to_a_restarted_stream() {
        let hub = Hub::default();
        hub.set_kit(kit());
        hub.set_config(Arc::new(config()));
        assert!(!hub.send(DrumCommand::Trigger {
            pad: 0,
            velocity: 90
        }));
        let (tx, rx) = std::sync::mpsc::channel();
        hub.attach(tx, 48000);
        assert!(matches!(rx.try_recv(), Ok(DrumCommand::Config(_))));
        assert!(matches!(rx.try_recv(), Ok(DrumCommand::Kit(_))));
        let (tx, rx) = std::sync::mpsc::channel();
        hub.attach(tx, 44100);
        assert!(matches!(rx.try_recv(), Ok(DrumCommand::Config(_))));
        assert!(
            rx.try_recv().is_err(),
            "a kit made for another rate is not replayed"
        );
    }
}
