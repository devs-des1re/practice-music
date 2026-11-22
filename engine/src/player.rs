use std::sync::Arc;

use crate::click::builtin_click;
use crate::stretch::Stretcher;

pub enum Command {
    Load(Arc<Vec<f32>>),
    Play,
    Pause,
    Seek(usize),
    Speed(f64),
    Pitch(f64),
    Volume(f32),
    Loop {
        start: usize,
        end: usize,
        enabled: bool,
    },
    CountIn {
        beats: u32,
        spacing: usize,
    },
}

struct CountIn {
    beats_left: u32,
    spacing: f64,
    until_next: f64,
    index: u32,
}

#[derive(Clone, Copy)]
enum Voice {
    Idle,
    Normal(usize),
    Accent(usize),
}

pub struct PlayerCore {
    track: Option<Arc<Vec<f32>>>,
    len: usize,
    pos: usize,
    src_cursor: usize,
    playing: bool,
    speed: f64,
    pitch: f64,
    volume: f32,
    loop_enabled: bool,
    loop_start: usize,
    loop_end: usize,
    loops: u64,
    stretcher: Stretcher,
    stretched: bool,
    ended_at: Option<usize>,
    count_in_beats: u32,
    count_in_spacing: usize,
    count_in: Option<CountIn>,
    click_normal: Box<[f32]>,
    click_accent: Box<[f32]>,
    voice: Voice,
    scratch: Vec<f32>,
}

const MAX_CHUNK: usize = 4096;

impl PlayerCore {
    pub fn new(rate: u32) -> Self {
        Self {
            track: None,
            len: 0,
            pos: 0,
            src_cursor: 0,
            playing: false,
            speed: 1.0,
            pitch: 0.0,
            volume: 0.9,
            loop_enabled: false,
            loop_start: 0,
            loop_end: 0,
            loops: 0,
            stretcher: Stretcher::new(1024),
            stretched: false,
            ended_at: None,
            count_in_beats: 0,
            count_in_spacing: 0,
            count_in: None,
            click_normal: builtin_click(rate, 1000.0, 0.9),
            click_accent: builtin_click(rate, 1600.0, 1.0),
            voice: Voice::Idle,
            scratch: vec![0.0; MAX_CHUNK * 2],
        }
    }

    pub fn apply(&mut self, command: Command) {
        match command {
            Command::Load(track) => {
                self.len = track.len() / 2;
                self.track = Some(track);
                self.pos = 0;
                self.src_cursor = 0;
                self.playing = false;
                self.loops = 0;
                self.loop_enabled = false;
                self.count_in = None;
                self.enter_mode();
            }
            Command::Play => {
                if self.track.is_none() {
                    return;
                }
                if self.pos >= self.len {
                    self.seek(0);
                }
                self.playing = true;
                if self.count_in_beats > 0 && self.count_in_spacing > 0 {
                    self.count_in = Some(CountIn {
                        beats_left: self.count_in_beats,
                        spacing: self.count_in_spacing as f64,
                        until_next: 0.0,
                        index: 0,
                    });
                }
            }
            Command::Pause => {
                self.playing = false;
                self.count_in = None;
                if self.stretched {
                    self.pos = self.estimated_position().round() as usize;
                    self.src_cursor = self.pos;
                    self.stretcher.reset();
                    self.ended_at = None;
                }
            }
            Command::Seek(frame) => self.seek(frame),
            Command::Speed(v) => {
                self.speed = v.clamp(0.25, 2.0);
                self.enter_mode();
            }
            Command::Pitch(semitones) => {
                self.pitch = semitones.clamp(-12.0, 12.0);
                self.enter_mode();
            }
            Command::Volume(v) => self.volume = v.clamp(0.0, 1.5),
            Command::Loop {
                start,
                end,
                enabled,
            } => {
                self.loop_start = start.min(self.len);
                self.loop_end = end.min(self.len);
                self.loop_enabled = enabled && self.loop_end > self.loop_start + 64;
            }
            Command::CountIn { beats, spacing } => {
                self.count_in_beats = beats.min(16);
                self.count_in_spacing = spacing;
            }
        }
    }

    fn wants_stretch(&self) -> bool {
        (self.speed - 1.0).abs() > 1e-9 || self.pitch.abs() > 1e-9
    }

    fn enter_mode(&mut self) {
        let want = self.wants_stretch();
        if want {
            self.stretcher.set_speed(self.speed);
            self.stretcher.set_pitch_semitones(self.pitch);
        }
        if want != self.stretched {
            if want {
                self.src_cursor = self.pos;
                self.stretcher.reset();
                self.ended_at = None;
            } else {
                self.pos = self.estimated_position().round() as usize;
                self.pos = self.pos.min(self.len);
            }
            self.stretched = want;
        }
    }

    fn seek(&mut self, frame: usize) {
        let frame = frame.min(self.len);
        self.pos = frame;
        self.src_cursor = frame;
        if self.stretched {
            self.stretcher.reset();
            self.ended_at = None;
        }
    }

    pub fn estimated_position(&self) -> f64 {
        if !self.stretched {
            return self.pos as f64;
        }
        let behind = self.stretcher.fed() as f64 - self.stretcher.analysis_position();
        let mut p = self.src_cursor as f64 - behind.max(0.0);
        if self.loop_enabled
            && p < self.loop_start as f64
            && self.src_cursor >= self.loop_start
            && self.src_cursor < self.loop_end
        {
            p += (self.loop_end - self.loop_start) as f64;
        }
        p.clamp(0.0, self.len as f64)
    }

    pub fn position(&self) -> f64 {
        self.estimated_position()
    }

    pub fn playing(&self) -> bool {
        self.playing
    }

    pub fn loops(&self) -> u64 {
        self.loops
    }

    fn fire_click(&mut self, accent: bool) {
        self.voice = if accent {
            Voice::Accent(0)
        } else {
            Voice::Normal(0)
        };
    }

    fn mix_click(&mut self, out: &mut [f32], channels: usize, frame: usize) {
        let (table, idx) = match self.voice {
            Voice::Idle => return,
            Voice::Normal(i) => (&self.click_normal, i),
            Voice::Accent(i) => (&self.click_accent, i),
        };
        let v = table[idx] * 0.7;
        let write = channels.min(2);
        for ch in 0..write {
            out[frame * channels + ch] += v;
        }
        let next = idx + 1;
        self.voice = if next >= table.len() {
            Voice::Idle
        } else if matches!(self.voice, Voice::Accent(_)) {
            Voice::Accent(next)
        } else {
            Voice::Normal(next)
        };
    }

    pub fn mix_into(&mut self, out: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        let frames = out.len() / channels;
        let mut done = 0usize;
        while done < frames {
            let n = (frames - done).min(MAX_CHUNK);
            self.mix_chunk(&mut out[done * channels..(done + n) * channels], channels);
            done += n;
        }
    }

    fn mix_chunk(&mut self, out: &mut [f32], channels: usize) {
        let frames = out.len() / channels;
        let mut start = 0usize;
        if self.playing
            && let Some(mut ci) = self.count_in.take()
        {
            let mut finished = false;
            for frame in 0..frames {
                if ci.until_next <= 0.0 {
                    if ci.beats_left == 0 {
                        finished = true;
                        start = frame;
                        break;
                    }
                    self.fire_click(ci.index == 0);
                    ci.beats_left -= 1;
                    ci.until_next += ci.spacing;
                    ci.index += 1;
                }
                ci.until_next -= 1.0;
                self.mix_click(out, channels, frame);
            }
            if !finished {
                self.count_in = Some(ci);
                return;
            }
        }
        if self.voice_active() {
            for frame in start..frames {
                self.mix_click(out, channels, frame);
            }
        }
        if !self.playing || self.track.is_none() {
            return;
        }
        if self.stretched {
            self.render_stretched(out, channels, start);
        } else {
            self.render_direct(out, channels, start);
        }
    }

    fn voice_active(&self) -> bool {
        !matches!(self.voice, Voice::Idle)
    }

    fn render_direct(&mut self, out: &mut [f32], channels: usize, start: usize) {
        let track = match &self.track {
            Some(t) => Arc::clone(t),
            None => return,
        };
        let frames = out.len() / channels;
        let write = channels.min(2);
        for frame in start..frames {
            if self.loop_enabled && self.pos >= self.loop_end {
                self.pos = self.loop_start;
                self.loops += 1;
            }
            if self.pos >= self.len {
                self.playing = false;
                return;
            }
            for ch in 0..write {
                out[frame * channels + ch] += track[self.pos * 2 + ch] * self.volume;
            }
            self.pos += 1;
        }
    }

    fn render_stretched(&mut self, out: &mut [f32], channels: usize, start: usize) {
        let track = match &self.track {
            Some(t) => Arc::clone(t),
            None => return,
        };
        let frames = out.len() / channels - start;
        if frames == 0 {
            return;
        }
        let mut buf = std::mem::take(&mut self.scratch);
        let write = channels.min(2);
        {
            let loop_enabled = self.loop_enabled;
            let loop_start = self.loop_start;
            let loop_end = self.loop_end;
            let len = self.len;
            let cursor = &mut self.src_cursor;
            let loops = &mut self.loops;
            let ended = &mut self.ended_at;
            let fed_before = self.stretcher.fed();
            let mut fed_local = fed_before;
            let mut feed = |chunk: &mut [f32]| {
                let n = chunk.len() / 2;
                for i in 0..n {
                    if loop_enabled && *cursor >= loop_end {
                        *cursor = loop_start;
                        *loops += 1;
                    }
                    if *cursor >= len {
                        chunk[i * 2] = 0.0;
                        chunk[i * 2 + 1] = 0.0;
                        if ended.is_none() {
                            *ended = Some(fed_local + i);
                        }
                    } else {
                        chunk[i * 2] = track[*cursor * 2];
                        chunk[i * 2 + 1] = track[*cursor * 2 + 1];
                        *cursor += 1;
                    }
                }
                fed_local += n;
            };
            self.stretcher.render(&mut buf[..frames * 2], &mut feed);
        }
        for i in 0..frames {
            for ch in 0..write {
                out[(start + i) * channels + ch] += buf[i * 2 + ch] * self.volume;
            }
        }
        self.scratch = buf;
        if let Some(end) = self.ended_at
            && self.stretcher.analysis_position() >= end as f64
        {
            self.playing = false;
            self.pos = self.len;
            self.src_cursor = self.len;
            self.stretcher.reset();
            self.ended_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(frames: usize) -> Arc<Vec<f32>> {
        Arc::new(
            (0..frames)
                .flat_map(|i| [i as f32 / 100000.0, -(i as f32) / 100000.0])
                .collect(),
        )
    }

    fn player_with(frames: usize) -> PlayerCore {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(ramp(frames)));
        p
    }

    fn render(p: &mut PlayerCore, total: usize, chunk: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut done = 0;
        while done < total {
            let n = chunk.min(total - done);
            let mut buf = vec![0.0f32; n * 2];
            p.mix_into(&mut buf, 2);
            for f in 0..n {
                out.push(buf[f * 2]);
            }
            done += n;
        }
        out
    }

    fn source(i: usize) -> f32 {
        i as f32 / 100000.0
    }

    #[test]
    fn plays_the_source_exactly_from_the_start() {
        let mut p = player_with(5000);
        p.apply(Command::Play);
        let out = render(&mut p, 1000, 128);
        for (i, v) in out.iter().enumerate() {
            assert_eq!(*v, source(i), "frame {i}");
        }
        assert_eq!(p.position() as usize, 1000);
    }

    #[test]
    fn nothing_plays_until_play_and_pause_holds_the_position() {
        let mut p = player_with(5000);
        assert!(render(&mut p, 256, 64).iter().all(|v| *v == 0.0));
        p.apply(Command::Play);
        render(&mut p, 500, 100);
        p.apply(Command::Pause);
        assert!(render(&mut p, 300, 100).iter().all(|v| *v == 0.0));
        assert_eq!(p.position() as usize, 500);
        p.apply(Command::Play);
        assert_eq!(render(&mut p, 1, 1)[0], source(500));
    }

    #[test]
    fn loop_boundaries_are_sample_exact_at_any_buffer_size() {
        for chunk in [1usize, 7, 64, 333, 1024, 4096] {
            let mut p = player_with(10000);
            p.apply(Command::Loop {
                start: 1000,
                end: 1500,
                enabled: true,
            });
            p.apply(Command::Seek(1000));
            p.apply(Command::Play);
            let out = render(&mut p, 2600, chunk);
            for (i, v) in out.iter().enumerate() {
                let want = source(1000 + i % 500);
                assert_eq!(*v, want, "chunk {chunk}, output frame {i}");
            }
            assert_eq!(p.loops(), 5, "chunk {chunk}");
        }
    }

    #[test]
    fn a_loop_entered_from_before_it_runs_through_then_wraps() {
        let mut p = player_with(10000);
        p.apply(Command::Loop {
            start: 2000,
            end: 2200,
            enabled: true,
        });
        p.apply(Command::Seek(1900));
        p.apply(Command::Play);
        let out = render(&mut p, 500, 100);
        assert_eq!(out[0], source(1900));
        assert_eq!(out[299], source(2199));
        assert_eq!(out[300], source(2000));
        assert_eq!(p.loops(), 1);
    }

    #[test]
    fn a_tiny_or_disabled_loop_is_ignored() {
        let mut p = player_with(3000);
        p.apply(Command::Loop {
            start: 100,
            end: 120,
            enabled: true,
        });
        p.apply(Command::Play);
        let out = render(&mut p, 400, 50);
        assert_eq!(out[399], source(399));
        assert_eq!(p.loops(), 0);
    }

    #[test]
    fn playback_stops_at_the_end_and_play_restarts_from_the_beginning() {
        let mut p = player_with(300);
        p.apply(Command::Play);
        render(&mut p, 600, 100);
        assert!(!p.playing());
        p.apply(Command::Play);
        assert_eq!(render(&mut p, 1, 1)[0], source(0));
    }

    #[test]
    fn count_in_clicks_precede_the_audio_by_exact_spacing() {
        let mut p = player_with(20000);
        p.apply(Command::CountIn {
            beats: 4,
            spacing: 6000,
        });
        p.apply(Command::Play);
        let out = render(&mut p, 26000, 480);
        for beat in 0..4 {
            let at = beat * 6000;
            let window = &out[at..at + 40];
            assert!(
                window.iter().any(|v| v.abs() > 0.1),
                "no click at beat {beat}"
            );
            assert!(
                out[at.saturating_sub(300)..at]
                    .iter()
                    .all(|v| v.abs() < 1e-6)
                    || beat == 0
            );
        }
        assert_eq!(out[24000], source(0));
        assert_eq!(out[24000 + 777], source(777));
        assert!(
            out[5000..5900].iter().all(|v| v.abs() < 0.01),
            "silence between count-in clicks"
        );
    }

    #[test]
    fn count_in_survives_buffer_boundaries() {
        let mut a = player_with(20000);
        let mut b = player_with(20000);
        for p in [&mut a, &mut b] {
            p.apply(Command::CountIn {
                beats: 3,
                spacing: 4001,
            });
            p.apply(Command::Play);
        }
        let x = render(&mut a, 16000, 16000);
        let y = render(&mut b, 16000, 97);
        assert_eq!(x, y);
        assert_eq!(x[3 * 4001], source(0));
    }

    #[test]
    fn volume_scales_the_audio() {
        let mut p = player_with(2000);
        p.apply(Command::Volume(0.5));
        p.apply(Command::Play);
        assert_eq!(render(&mut p, 100, 100)[50], source(50) * 0.5);
    }

    #[test]
    fn seeking_is_clamped_and_works_while_playing() {
        let mut p = player_with(1000);
        p.apply(Command::Play);
        render(&mut p, 100, 100);
        p.apply(Command::Seek(600));
        assert_eq!(render(&mut p, 1, 1)[0], source(600));
        p.apply(Command::Seek(99999));
        assert_eq!(p.position() as usize, 1000);
    }

    #[test]
    fn extra_output_channels_stay_silent() {
        let mut p = player_with(500);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Play);
        let mut buf = vec![0.0f32; 4 * 10];
        p.mix_into(&mut buf, 4);
        assert_eq!(buf[4 * 5], source(5));
        assert_eq!(buf[4 * 5 + 2], 0.0);
        assert_eq!(buf[4 * 5 + 3], 0.0);
    }

    fn tone_track(frames: usize) -> Arc<Vec<f32>> {
        Arc::new(
            (0..frames)
                .flat_map(|i| {
                    let v = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin() * 0.5;
                    [v, v]
                })
                .collect(),
        )
    }

    #[test]
    fn slow_playback_advances_the_position_at_the_requested_speed() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 20)));
        p.apply(Command::Speed(0.5));
        p.apply(Command::Play);
        render(&mut p, 48000 * 4, 480);
        let pos = p.position() / 48000.0;
        assert!(
            (pos - 2.0).abs() < 0.2,
            "after 4 s at half speed the position was {pos}s"
        );
    }

    #[test]
    fn slow_loops_wrap_and_stay_inside_the_region() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 20)));
        p.apply(Command::Loop {
            start: 48000,
            end: 48000 * 2,
            enabled: true,
        });
        p.apply(Command::Seek(48000));
        p.apply(Command::Speed(0.5));
        p.apply(Command::Play);
        let mut min_pos = f64::MAX;
        let mut max_pos = 0.0f64;
        for _ in 0..(48000 * 6 / 480) {
            let mut buf = vec![0.0f32; 480 * 2];
            p.mix_into(&mut buf, 2);
            assert!(buf.iter().all(|v| v.is_finite() && v.abs() <= 1.2));
            let pos = p.position();
            min_pos = min_pos.min(pos);
            max_pos = max_pos.max(pos);
        }
        assert!(p.loops() >= 2, "loops {}", p.loops());
        assert!(
            min_pos >= 48000.0 - 4000.0 && max_pos <= 48000.0 * 2.0 + 100.0,
            "position range {min_pos}..{max_pos}"
        );
        assert!(p.playing());
    }

    #[test]
    fn returning_to_normal_speed_continues_from_about_the_same_place() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 20)));
        p.apply(Command::Speed(0.75));
        p.apply(Command::Play);
        render(&mut p, 48000 * 2, 480);
        let before = p.position();
        p.apply(Command::Speed(1.0));
        let after = p.position();
        assert!((before - after).abs() < 2000.0, "{before} -> {after}");
        render(&mut p, 480, 480);
        assert!(p.position() > after);
    }

    #[test]
    fn stretched_playback_stops_cleanly_at_the_end_of_the_track() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 3)));
        p.apply(Command::Speed(1.5));
        p.apply(Command::Play);
        render(&mut p, 48000 * 4, 480);
        assert!(!p.playing());
        assert_eq!(p.position() as usize, 48000 * 3);
    }

    #[test]
    fn pitch_shift_alone_keeps_the_playback_speed() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 20)));
        p.apply(Command::Pitch(3.0));
        p.apply(Command::Play);
        render(&mut p, 48000 * 4, 480);
        let pos = p.position() / 48000.0;
        assert!((pos - 4.0).abs() < 0.25, "position {pos}s after 4 s");
    }

    #[test]
    fn pause_in_stretched_mode_keeps_the_place() {
        let mut p = PlayerCore::new(48000);
        p.apply(Command::Volume(1.0));
        p.apply(Command::Load(tone_track(48000 * 10)));
        p.apply(Command::Speed(0.6));
        p.apply(Command::Play);
        render(&mut p, 48000 * 2, 480);
        p.apply(Command::Pause);
        let at = p.position();
        assert!(render(&mut p, 4800, 480).iter().all(|v| *v == 0.0));
        assert!((p.position() - at).abs() < 1.0);
        p.apply(Command::Play);
        render(&mut p, 480, 480);
        assert!(p.position() >= at);
    }
}
