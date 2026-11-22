use std::sync::mpsc::Receiver;

use crate::audio::Shared;
use crate::click::Renderer;
use crate::player::{Command, PlayerCore};

pub struct Dsp {
    renderer: Renderer,
    player: PlayerCore,
    rx: Receiver<Command>,
    channels: usize,
}

impl Dsp {
    pub fn new(rate: u32, channels: usize, rx: Receiver<Command>) -> Self {
        Self {
            renderer: Renderer::with_builtin(rate, channels),
            player: PlayerCore::new(rate),
            rx,
            channels,
        }
    }

    pub fn process(&mut self, shared: &Shared, data: &mut [f32]) -> Option<u64> {
        self.renderer.apply(&shared.controls);
        while let Ok(command) = self.rx.try_recv() {
            self.player.apply(command);
        }
        let started = self.renderer.render(data);
        self.player.mix_into(data, self.channels);
        shared.set_player_state(
            self.player.position(),
            self.player.playing(),
            self.player.loops(),
        );
        started
    }
}
