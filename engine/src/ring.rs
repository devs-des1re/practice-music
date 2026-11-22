use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

pub struct FrameRing {
    data: Box<[AtomicU32]>,
    channels: usize,
    capacity: usize,
    write: AtomicU64,
    read: AtomicU64,
    overruns: AtomicU64,
    underruns: AtomicU64,
    max_push: AtomicU32,
    gated: bool,
    active: AtomicBool,
}

impl FrameRing {
    pub fn new(channels: usize, capacity_frames: usize) -> Self {
        let channels = channels.max(1);
        let capacity = capacity_frames.max(64);
        Self {
            data: (0..channels * capacity).map(|_| AtomicU32::new(0)).collect(),
            channels,
            capacity,
            write: AtomicU64::new(0),
            read: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            max_push: AtomicU32::new(0),
            gated: false,
            active: AtomicBool::new(true),
        }
    }

    pub fn gated(channels: usize, capacity_frames: usize) -> Self {
        let mut ring = Self::new(channels, capacity_frames);
        ring.gated = true;
        ring.active = AtomicBool::new(false);
        ring
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn fill(&self) -> usize {
        let w = self.write.load(Ordering::Acquire);
        let r = self.read.load(Ordering::Acquire);
        w.saturating_sub(r) as usize
    }

    pub fn overruns(&self) -> u64 {
        self.overruns.load(Ordering::Relaxed)
    }

    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }

    pub fn note_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn max_push(&self) -> usize {
        self.max_push.load(Ordering::Relaxed) as usize
    }

    pub fn push(&self, interleaved: &[f32]) {
        let frames = interleaved.len() / self.channels;
        if frames == 0 || (self.gated && !self.active.load(Ordering::Relaxed)) {
            return;
        }
        self.max_push.fetch_max(frames as u32, Ordering::Relaxed);
        let w = self.write.load(Ordering::Relaxed);
        let r = self.read.load(Ordering::Acquire);
        let used = w.saturating_sub(r) as usize;
        let free = self.capacity.saturating_sub(used);
        let take = frames.min(free);
        if take < frames {
            self.overruns.fetch_add(1, Ordering::Relaxed);
        }
        for f in 0..take {
            let slot = ((w + f as u64) % self.capacity as u64) as usize * self.channels;
            for c in 0..self.channels {
                self.data[slot + c].store(interleaved[f * self.channels + c].to_bits(), Ordering::Relaxed);
            }
        }
        self.write.store(w + take as u64, Ordering::Release);
    }

    fn sample(&self, frame: u64, channel: usize) -> f32 {
        let slot = (frame % self.capacity as u64) as usize * self.channels + channel;
        f32::from_bits(self.data[slot].load(Ordering::Relaxed))
    }
}

pub struct DriftReader {
    nominal: f64,
    pos: f64,
    primed: bool,
    max_read: usize,
}

const MAX_TRIM: f64 = 0.005;
const GAIN: f64 = 0.02;

impl DriftReader {
    pub fn new(source_rate: u32, dest_rate: u32) -> Self {
        Self {
            nominal: f64::from(source_rate) / f64::from(dest_rate.max(1)),
            pos: 0.0,
            primed: false,
            max_read: 0,
        }
    }

    pub fn target(&self, ring: &FrameRing) -> usize {
        let wanted = 2 * ring.max_push() + 2 * self.max_read + 64;
        wanted.clamp(256, ring.capacity() / 4)
    }

    pub fn read(&mut self, ring: &FrameRing, out: &mut [f32]) -> bool {
        let channels = ring.channels();
        if ring.gated {
            ring.active.store(true, Ordering::Relaxed);
        }
        let frames = out.len() / channels;
        self.max_read = self.max_read.max(frames);
        let target = self.target(ring) as f64;
        let write = ring.write.load(Ordering::Acquire);
        if !self.primed {
            if (write.saturating_sub(ring.read.load(Ordering::Acquire)) as f64) < target {
                out.fill(0.0);
                return false;
            }
            self.pos = write as f64 - target;
            self.primed = true;
        }
        let fill = write as f64 - self.pos;
        if fill > target * 4.0 {
            self.pos = write as f64 - target;
        }
        let fill = write as f64 - self.pos;
        let trim = ((fill - target) / target * GAIN).clamp(-MAX_TRIM, MAX_TRIM);
        let step = self.nominal * (1.0 + trim);
        for f in 0..frames {
            let base = self.pos.floor();
            let idx = base as u64;
            if idx + 1 >= write {
                out[f * channels..].fill(0.0);
                ring.note_underrun();
                self.primed = false;
                ring.read.store(write.saturating_sub(1), Ordering::Release);
                return false;
            }
            let frac = (self.pos - base) as f32;
            for c in 0..channels {
                let a = ring.sample(idx, c);
                let b = ring.sample(idx + 1, c);
                out[f * channels + c] = a + (b - a) * frac;
            }
            self.pos += step;
        }
        ring.read.store(self.pos.floor() as u64, Ordering::Release);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn simulate(
        producer_rate: f64,
        consumer_rate: f64,
        producer_block: usize,
        consumer_block: usize,
        seconds: f64,
        freq: f64,
    ) -> (Vec<f32>, FrameRing, DriftReader) {
        let ring = FrameRing::new(1, 16384);
        let mut reader = DriftReader::new(producer_rate as u32, consumer_rate as u32);
        let mut produced = 0u64;
        let mut consumed = 0u64;
        let mut out_all = Vec::new();
        let total = seconds;
        let mut t = 0.0f64;
        let dt = 1.0 / 20000.0;
        let mut next_prod = 0.0f64;
        let mut next_cons = 0.0f64;
        while t < total {
            if t >= next_prod {
                let block: Vec<f32> = (0..producer_block)
                    .map(|i| {
                        (2.0 * PI * freq * (produced + i as u64) as f64 / producer_rate).sin() as f32
                    })
                    .collect();
                ring.push(&block);
                produced += producer_block as u64;
                next_prod += producer_block as f64 / producer_rate;
            }
            if t >= next_cons {
                let mut block = vec![0.0f32; consumer_block];
                let ok = reader.read(&ring, &mut block);
                if ok && t > 0.5 {
                    out_all.extend_from_slice(&block);
                }
                consumed += consumer_block as u64;
                next_cons += consumer_block as f64 / consumer_rate;
            }
            t += dt;
        }
        let _ = consumed;
        (out_all, ring, reader)
    }

    fn max_step(signal: &[f32]) -> f32 {
        signal.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn equal_rates_stream_without_gaps() {
        let (out, ring, _) = simulate(48000.0, 48000.0, 480, 128, 4.0, 440.0);
        assert_eq!(ring.underruns(), 0);
        assert_eq!(ring.overruns(), 0);
        assert!(out.len() > 48000);
        let limit = (2.0 * PI * 440.0 / 48000.0 * 1.2) as f32;
        assert!(max_step(&out) < limit, "step {}", max_step(&out));
    }

    #[test]
    fn a_fast_producer_is_absorbed_by_the_drift_control() {
        let (_, ring, reader) = simulate(48010.0, 48000.0, 480, 128, 20.0, 300.0);
        assert_eq!(ring.underruns(), 0);
        assert_eq!(ring.overruns(), 0);
        let target = reader.target(&ring) as f64;
        assert!((ring.fill() as f64 - target).abs() < target, "fill {}", ring.fill());
    }

    #[test]
    fn a_slow_producer_is_absorbed_by_the_drift_control() {
        let (_, ring, reader) = simulate(47990.0, 48000.0, 480, 128, 20.0, 300.0);
        assert_eq!(ring.underruns(), 0);
        assert_eq!(ring.overruns(), 0);
        let target = reader.target(&ring) as f64;
        assert!((ring.fill() as f64 - target).abs() < target, "fill {}", ring.fill());
    }

    #[test]
    fn different_rates_are_converted_and_keep_the_pitch() {
        let (out, ring, _) = simulate(44100.0, 48000.0, 441, 256, 4.0, 1000.0);
        assert_eq!(ring.underruns(), 0);
        let crossings = out
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count() as f64;
        let seconds = out.len() as f64 / 48000.0;
        let measured = crossings / seconds;
        assert!((measured - 1000.0).abs() < 8.0, "measured {measured}");
    }

    #[test]
    fn an_empty_ring_gives_silence_and_waits_to_prime() {
        let ring = FrameRing::new(2, 4096);
        let mut reader = DriftReader::new(48000, 48000);
        let mut out = vec![1.0f32; 512];
        assert!(!reader.read(&ring, &mut out));
        assert!(out.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_starved_reader_counts_the_underrun_and_recovers() {
        let ring = FrameRing::new(1, 4096);
        let mut reader = DriftReader::new(48000, 48000);
        ring.push(&vec![0.5f32; 1200]);
        let mut out = vec![0.0f32; 64];
        assert!(reader.read(&ring, &mut out));
        let mut big = vec![0.0f32; 2000];
        assert!(!reader.read(&ring, &mut big));
        assert_eq!(ring.underruns(), 1);
        ring.push(&vec![0.5f32; 1200]);
        assert!(reader.read(&ring, &mut out));
        assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn a_gated_ring_ignores_frames_until_its_reader_starts() {
        let ring = FrameRing::gated(1, 1024);
        ring.push(&vec![1.0f32; 300]);
        assert_eq!(ring.fill(), 0);
        let mut reader = DriftReader::new(48000, 48000);
        let mut out = vec![0.0f32; 32];
        assert!(!reader.read(&ring, &mut out));
        ring.push(&vec![1.0f32; 600]);
        assert_eq!(ring.fill(), 600);
    }

    #[test]
    fn a_full_ring_drops_new_frames_instead_of_overwriting() {
        let ring = FrameRing::new(1, 128);
        ring.push(&vec![1.0f32; 100]);
        ring.push(&vec![2.0f32; 100]);
        assert_eq!(ring.overruns(), 1);
        assert_eq!(ring.fill(), 128);
    }

    #[test]
    fn channels_stay_interleaved_through_the_ring() {
        let ring = FrameRing::new(2, 4096);
        let mut reader = DriftReader::new(48000, 48000);
        let block: Vec<f32> = (0..2000).flat_map(|_| [0.25f32, -0.75]).collect();
        ring.push(&block);
        let mut out = vec![0.0f32; 2 * 100];
        assert!(reader.read(&ring, &mut out));
        for f in out.as_chunks::<2>().0.iter() {
            assert!((f[0] - 0.25).abs() < 1e-6 && (f[1] + 0.75).abs() < 1e-6);
        }
    }
}
