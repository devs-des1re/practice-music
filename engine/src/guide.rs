pub const MAX_CUES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub frames_per_beat: f64,
    pub offset: f64,
    pub beats_per_bar: u32,
    pub downbeat: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cue {
    pub frame: usize,
    pub beat: u32,
    pub bar: u32,
    pub beats_per_bar: u32,
    pub division: u32,
}

pub struct Follower {
    grid: Option<Grid>,
    subdivision: u32,
    tolerance: f64,
    last: Option<i64>,
    cues: [Cue; MAX_CUES],
    len: usize,
}

impl Follower {
    pub fn new(rate: u32) -> Self {
        Self {
            grid: None,
            subdivision: 1,
            tolerance: f64::from(rate) * 0.002,
            last: None,
            cues: [Cue::default(); MAX_CUES],
            len: 0,
        }
    }

    pub fn set_grid(&mut self, grid: Option<Grid>) {
        self.grid = grid.filter(|g| g.frames_per_beat > 1.0 && g.beats_per_bar > 0);
        self.last = None;
    }

    pub fn set_subdivision(&mut self, subdivision: u32) {
        let next = subdivision.clamp(1, 8);
        if next != self.subdivision {
            self.subdivision = next;
            self.last = None;
        }
    }

    pub fn active(&self) -> bool {
        self.grid.is_some()
    }

    pub fn restart(&mut self) {
        self.last = None;
    }

    pub fn clear(&mut self) {
        self.len = 0;
    }

    pub fn cues(&self) -> &[Cue] {
        &self.cues[..self.len]
    }

    fn tick_at(&self, grid: &Grid, position: f64) -> i64 {
        let length = grid.frames_per_beat / f64::from(self.subdivision);
        ((position - grid.offset) / length + 1e-7).floor() as i64
    }

    pub fn observe(&mut self, position: f64, frame: usize) {
        let Some(grid) = self.grid else {
            return;
        };
        let tick = self.tick_at(&grid, position);
        let previous = match self.last {
            Some(previous) => previous,
            None => self.tick_at(&grid, position - self.tolerance),
        };
        if tick <= previous {
            self.last = Some(previous);
            return;
        }
        self.last = Some(tick);
        if self.len >= MAX_CUES {
            return;
        }
        let per_beat = i64::from(self.subdivision);
        let beat = tick.div_euclid(per_beat) - grid.downbeat;
        let per_bar = i64::from(grid.beats_per_bar);
        self.cues[self.len] = Cue {
            frame,
            beat: beat.rem_euclid(per_bar) as u32,
            bar: beat.div_euclid(per_bar).max(0) as u32,
            beats_per_bar: grid.beats_per_bar,
            division: tick.rem_euclid(per_beat) as u32,
        };
        self.len += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Grid {
        Grid {
            frames_per_beat: 100.0,
            offset: 20.0,
            beats_per_bar: 4,
            downbeat: 0,
        }
    }

    fn run(f: &mut Follower, from: usize, to: usize) -> Vec<(usize, u32, u32)> {
        let mut out = Vec::new();
        for p in from..to {
            f.clear();
            f.observe(p as f64, p);
            out.extend(f.cues().iter().map(|c| (c.frame, c.beat, c.division)));
        }
        out
    }

    #[test]
    fn a_cue_lands_exactly_on_every_beat_once() {
        let mut f = Follower::new(1000);
        f.set_grid(Some(grid()));
        assert_eq!(
            run(&mut f, 0, 520),
            vec![
                (20, 0, 0),
                (120, 1, 0),
                (220, 2, 0),
                (320, 3, 0),
                (420, 0, 0)
            ]
        );
    }

    #[test]
    fn subdivisions_and_the_downbeat_are_counted() {
        let mut f = Follower::new(1000);
        f.set_grid(Some(Grid {
            downbeat: 1,
            ..grid()
        }));
        f.set_subdivision(2);
        assert_eq!(
            run(&mut f, 100, 230),
            vec![(120, 0, 0), (170, 0, 1), (220, 1, 0)]
        );
    }

    #[test]
    fn starting_on_or_just_after_a_beat_still_clicks_it() {
        let mut f = Follower::new(1000);
        f.set_grid(Some(grid()));
        assert_eq!(run(&mut f, 120, 121), vec![(120, 1, 0)]);
        f.restart();
        assert_eq!(run(&mut f, 121, 122), vec![(121, 1, 0)]);
        f.restart();
        assert!(run(&mut f, 160, 180).is_empty());
    }

    #[test]
    fn a_small_step_backwards_never_repeats_a_click() {
        let mut f = Follower::new(1000);
        f.set_grid(Some(grid()));
        run(&mut f, 100, 125);
        assert!(run(&mut f, 117, 130).is_empty());
    }

    #[test]
    fn without_a_usable_grid_there_are_no_cues() {
        let mut f = Follower::new(1000);
        assert!(run(&mut f, 0, 300).is_empty());
        f.set_grid(Some(Grid {
            frames_per_beat: 0.0,
            ..grid()
        }));
        assert!(!f.active());
    }
}
