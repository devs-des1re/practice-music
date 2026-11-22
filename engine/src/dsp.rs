use crate::audio::{Inbox, Shared};
use crate::click::Renderer;
use crate::mixer::{
    BLOCK, INPUT_STRIPS, Mixer, STRIP_CLICK, STRIP_INPUT0, STRIP_SONG, STRIPS, mp, sp,
};
use crate::player::PlayerCore;
use crate::ring::DriftReader;
use crate::routing::{MAX_CAPTURE_CHANNELS, add_pair};

pub struct Dsp {
    renderer: Renderer,
    player: PlayerCore,
    inbox: Inbox,
    channels: usize,
    rate: u32,
    mixer: Mixer,
    strip_in: [Vec<f32>; STRIPS],
    main: Vec<f32>,
    monitor: Vec<f32>,
    capture_reader: Option<DriftReader>,
    capture_scratch: Vec<f32>,
    published_beat: u64,
}

impl Dsp {
    pub fn new(rate: u32, channels: usize, inbox: Inbox) -> Self {
        Self {
            renderer: Renderer::with_builtin(rate, 2),
            player: PlayerCore::new(rate),
            inbox,
            channels: channels.max(1),
            rate,
            mixer: Mixer::new(rate),
            strip_in: std::array::from_fn(|_| vec![0.0; BLOCK * 2]),
            main: vec![0.0; BLOCK * 2],
            monitor: vec![0.0; BLOCK * 2],
            capture_reader: None,
            capture_scratch: vec![0.0; BLOCK * MAX_CAPTURE_CHANNELS],
            published_beat: 0,
        }
    }

    fn fill_capture(&mut self, shared: &Shared, frames: usize) {
        let mut have = false;
        let mut cch = 0;
        if let Some(link) = shared.capture.get() {
            let reader = self
                .capture_reader
                .get_or_insert_with(|| DriftReader::new(link.rate, self.rate));
            cch = link.ring.channels();
            have = reader.read(&link.ring, &mut self.capture_scratch[..frames * cch]);
        }
        for i in 0..INPUT_STRIPS {
            let strip = STRIP_INPUT0 + i;
            let buf = &mut self.strip_in[strip][..frames * 2];
            if !have {
                buf.fill(0.0);
                continue;
            }
            let source = shared.params.get(strip, sp::SOURCE) as usize;
            let stereo = shared.params.flag(strip, sp::STEREO);
            for f in 0..frames {
                let base = f * cch;
                let l = if source < cch { self.capture_scratch[base + source] } else { 0.0 };
                let r = if stereo && source + 1 < cch {
                    self.capture_scratch[base + source + 1]
                } else {
                    l
                };
                buf[f * 2] = l;
                buf[f * 2 + 1] = r;
            }
        }
    }

    pub fn process(&mut self, shared: &Shared, data: &mut [f32]) -> Option<u64> {
        self.renderer.apply(&shared.controls);
        while let Ok(command) = self.inbox.player.try_recv() {
            self.player.apply(command);
        }
        while let Ok(sound) = self.inbox.sounds.try_recv() {
            self.renderer.set_table(sound.role, sound.table);
        }
        data.fill(0.0);
        let channels = self.channels;
        let total = data.len() / channels;
        let monitor_link = shared.monitor.get();
        let main_offset = shared.params.master(mp::MAIN_CHANNEL) as usize;
        let monitor_offset = shared.params.master(mp::MONITOR_CHANNEL) as usize;
        let mut started = None;
        let mut done = 0;
        while done < total {
            let n = (total - done).min(BLOCK);
            {
                let song = &mut self.strip_in[STRIP_SONG][..n * 2];
                song.fill(0.0);
                self.player.mix_into(song, 2);
            }
            let id = self.renderer.render(&mut self.strip_in[STRIP_CLICK][..n * 2]);
            if started.is_none() {
                started = id;
            }
            self.fill_capture(shared, n);
            self.mixer.process(
                &shared.params,
                &shared.meters,
                &mut self.strip_in,
                n,
                &mut self.main,
                &mut self.monitor,
                true,
            );
            let out = &mut data[done * channels..(done + n) * channels];
            add_pair(out, channels, &self.main[..n * 2], main_offset);
            match monitor_link {
                Some(link) => link.ring.push(&self.monitor[..n * 2]),
                None => add_pair(out, channels, &self.monitor[..n * 2], monitor_offset),
            }
            done += n;
        }
        let beats = self.renderer.beat_counter();
        if beats != self.published_beat {
            self.published_beat = beats;
            shared.controls.publish_beat(beats, self.renderer.last_beat());
        }
        shared.set_player_state(
            self.player.position(),
            self.player.playing(),
            self.player.loops(),
        );
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::Link;
    use crate::player::Command;
    use crate::ring::FrameRing;
    use std::sync::Arc;

    fn rig(channels: usize) -> (Dsp, Shared) {
        let (shared, inbox) = Shared::new(48000);
        (Dsp::new(48000, channels, inbox), shared)
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    fn run(dsp: &mut Dsp, shared: &Shared, frames: usize, channels: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut buf = vec![0.0f32; 480 * channels];
        let mut done = 0;
        while done < frames {
            let n = 480.min(frames - done);
            dsp.process(shared, &mut buf[..n * channels]);
            out.extend_from_slice(&buf[..n * channels]);
            done += n;
        }
        out
    }

    fn channel_peak(out: &[f32], channels: usize, ch: usize) -> f32 {
        out.chunks_exact(channels).fold(0.0f32, |m, f| m.max(f[ch].abs()))
    }

    #[test]
    fn the_click_reaches_the_main_pair_through_the_mixer() {
        let (mut dsp, shared) = rig(2);
        shared.controls.set_volume(0.8);
        shared.controls.set_running(true);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!(peak(&out) > 0.3);
        assert!(peak(&out) <= 1.0);
    }

    #[test]
    fn a_muted_click_strip_is_silent() {
        let (mut dsp, shared) = rig(2);
        shared.params.set(STRIP_CLICK, sp::MUTE, 1.0);
        shared.controls.set_running(true);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!(peak(&out) < 1e-6);
    }

    #[test]
    fn the_main_bus_can_be_sent_to_the_second_pair_of_a_four_channel_device() {
        let (mut dsp, shared) = rig(4);
        shared.params.set_master(mp::MAIN_CHANNEL, 2.0);
        shared.controls.set_running(true);
        let out = run(&mut dsp, &shared, 4800, 4);
        assert!(channel_peak(&out, 4, 0) == 0.0 && channel_peak(&out, 4, 1) == 0.0);
        assert!(channel_peak(&out, 4, 2) > 0.3 && channel_peak(&out, 4, 3) > 0.3);
    }

    #[test]
    fn the_monitor_pair_on_the_same_device_gets_only_what_is_sent_to_it() {
        let (mut dsp, shared) = rig(4);
        shared.params.set(STRIP_CLICK, sp::MAIN, crate::mixer::OFF_DB);
        shared.params.set(STRIP_CLICK, sp::MONITOR, 0.0);
        shared.params.set_master(mp::MONITOR_CHANNEL, 2.0);
        shared.controls.set_running(true);
        let out = run(&mut dsp, &shared, 4800, 4);
        assert!(channel_peak(&out, 4, 0) < 1e-6);
        assert!(channel_peak(&out, 4, 2) > 0.3);
    }

    #[test]
    fn a_separate_monitor_device_receives_its_mix_through_the_ring() {
        let (mut dsp, shared) = rig(2);
        let ring = Arc::new(FrameRing::gated(2, 16384));
        shared
            .monitor
            .set(Link {
                ring: Arc::clone(&ring),
                rate: 48000,
            })
            .ok()
            .unwrap();
        shared.params.set(STRIP_CLICK, sp::MAIN, crate::mixer::OFF_DB);
        shared.params.set(STRIP_CLICK, sp::MONITOR, 0.0);
        shared.controls.set_running(true);
        let mut reader = DriftReader::new(48000, 48000);
        let mut scratch = vec![0.0f32; 128];
        reader.read(&ring, &mut scratch);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!(peak(&out) < 1e-6);
        assert!(ring.fill() > 0);
    }

    #[test]
    fn capture_channels_feed_the_input_strips_by_source() {
        let (mut dsp, shared) = rig(2);
        let ring = Arc::new(FrameRing::new(4, 16384));
        shared
            .capture
            .set(Link {
                ring: Arc::clone(&ring),
                rate: 48000,
            })
            .ok()
            .unwrap();
        shared.params.set(STRIP_INPUT0, sp::MAIN, 0.0);
        shared.params.set(STRIP_INPUT0, sp::SOURCE, 2.0);
        shared.params.set(STRIP_INPUT0, sp::PAN, -1.0);
        for _ in 0..30 {
            let block: Vec<f32> = (0..480).flat_map(|_| [0.0f32, 0.0, 0.5, 0.0]).collect();
            ring.push(&block);
        }
        let mut out = Vec::new();
        let mut buf = vec![0.0f32; 128 * 2];
        for _ in 0..60 {
            dsp.process(&shared, &mut buf);
            out.extend_from_slice(&buf);
        }
        assert!(channel_peak(&out, 2, 0) > 0.3, "left {}", channel_peak(&out, 2, 0));
        assert!(channel_peak(&out, 2, 1) < 0.05);
    }

    #[test]
    fn without_a_capture_device_the_input_strips_are_silent() {
        let (mut dsp, shared) = rig(2);
        shared.params.set(STRIP_INPUT0, sp::MAIN, 0.0);
        shared.params.set(STRIP_INPUT0, sp::GAIN, 12.0);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!(peak(&out) == 0.0);
    }

    #[test]
    fn the_player_runs_on_the_song_strip_and_obeys_its_fader() {
        let (mut dsp, shared) = rig(2);
        let track: Vec<f32> = vec![0.5; 2 * 48000];
        dsp.player.apply(Command::Volume(1.0));
        dsp.player.apply(Command::Load(Arc::new(track)));
        dsp.player.apply(Command::Play);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!((out[out.len() - 2] - 0.5).abs() < 1e-3);
        shared.params.set(STRIP_SONG, sp::GAIN, -6.0);
        let out = run(&mut dsp, &shared, 9600, 2);
        assert!((out[out.len() - 2] - 0.25).abs() < 0.01, "{}", out[out.len() - 2]);
    }

    #[test]
    fn a_main_channel_pair_outside_the_device_is_silent_not_misrouted() {
        let (mut dsp, shared) = rig(2);
        shared.params.set_master(mp::MAIN_CHANNEL, 4.0);
        shared.controls.set_running(true);
        let out = run(&mut dsp, &shared, 4800, 2);
        assert!(peak(&out) == 0.0);
    }

    #[test]
    fn beats_are_published_for_the_reporter() {
        let (mut dsp, shared) = rig(2);
        shared.controls.set_running(true);
        run(&mut dsp, &shared, 48000, 2);
        let (seq, info) = shared.controls.beat();
        assert!(seq >= 2);
        assert_eq!(info.beats_per_bar, 4);
    }

    #[test]
    fn the_first_started_click_id_is_returned_across_blocks() {
        let (mut dsp, shared) = rig(2);
        let id = shared.controls.trigger();
        let mut buf = vec![0.0f32; 3000 * 2];
        assert_eq!(dsp.process(&shared, &mut buf), Some(id));
        assert_eq!(dsp.process(&shared, &mut buf), None);
    }

    #[test]
    fn sounds_sent_from_outside_replace_the_click_tables() {
        let (shared, inbox) = Shared::new(48000);
        let mut dsp = Dsp::new(48000, 2, inbox);
        let loud: Arc<[f32]> = Arc::from(vec![0.9f32; 200]);
        for role in 0..4 {
            shared.send_sound(role, Arc::clone(&loud));
        }
        shared.controls.set_volume(1.0);
        let id = shared.controls.trigger();
        let mut buf = vec![0.0f32; 480 * 2];
        assert_eq!(dsp.process(&shared, &mut buf), Some(id));
        assert!(buf[10] > 0.5);
    }
}
