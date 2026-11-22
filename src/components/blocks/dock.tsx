import { createSignal, createEffect, onCleanup } from "@krate/runtime";
import { PlayerStream, PlayerPlay, PlayerPause, PlayerSeek } from "../../../api/player.go";
import { AudioStream, StartAudio } from "../../../api/audio.go";
import {
  GetMetronome,
  MetronomeStart,
  MetronomeStop,
  MetronomeRevision,
  SessionEpoch,
  BeatStream,
} from "../../../api/session.go";
import { PlayGlyph, RunGlyph } from "../ui/glyphs";
import { LiveText } from "../ui/live-text";
import { emptyPlayer } from "../../lib/player";
import { formatClock } from "../../lib/waveform";
import { logger } from "../../lib/logger";
import type { AudioState, MetronomeSetup, PlayerState } from "../../lib/types";

const emptyAudio = {
  running: false,
  streamLatencyMs: 0,
  periodMs: 0,
  metronome: { running: false },
} as unknown as AudioState;

const emptyMetronome = {
  bpm: 120,
  beatsPerBar: 4,
  accents: [3, 2, 2, 2],
} as unknown as MetronomeSetup;

export function Dock() {
  const [st, setSt] = createSignal<PlayerState>(emptyPlayer);
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [cfg, setCfg] = createSignal<MetronomeSetup>(emptyMetronome);
  const [beat, setBeat] = createSignal(-1);
  const [seek, setSeek] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [titleText, setTitleText] = createSignal("No song loaded");
  const [subText, setSubText] = createSignal("Open one from the library");
  const [clockText, setClockText] = createSignal("0:00");
  const [lengthText, setLengthText] = createSignal("0:00");
  const [bpmText, setBpmText] = createSignal("120");

  createEffect(() => {
    const next = PlayerStream();
    if (next) setSt(next);
  });
  createEffect(() => {
    const next = AudioStream();
    if (next) setAudio(next);
  });
  createEffect(() => {
    SessionEpoch();
    MetronomeRevision();
    GetMetronome()
      .then((next) => setCfg(next))
      .catch((e) => logger.error("metronome settings failed", e));
  });

  createEffect(() => {
    const frame = BeatStream();
    if (!frame || !audio().metronome.running) return;
    const lead = audio().streamLatencyMs > 0 ? audio().streamLatencyMs : audio().periodMs;
    const delay = Math.min(150, Math.max(0, lead || 0));
    const timer = setTimeout(() => setBeat(frame.beat), delay);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    if (!audio().metronome.running) setBeat(-1);
  });

  createEffect(() => {
    const s = st();
    setTitleText(s.loaded ? s.title || "Untitled" : "No song loaded");
    setSubText(s.loaded ? s.artist || "Unknown artist" : "Open one from the library");
    setClockText(formatClock(s.positionMs));
    setLengthText(formatClock(s.durationMs));
    if (!dragging()) setSeek(s.positionMs);
  });
  createEffect(() => {
    const c = cfg();
    setBpmText(String(Math.round(c.bpm * 10) / 10));
  });

  function togglePlay() {
    const action = st().playing ? PlayerPause() : PlayerPlay();
    action.catch((e) => logger.error("transport failed", e));
  }

  function restart() {
    const l = st().loop;
    PlayerSeek(l.enabled ? l.startMs : 0).catch((e) => logger.error("seek failed", e));
  }

  async function toggleMetronome() {
    try {
      if (!audio().running) await StartAudio();
      if (audio().metronome.running) await MetronomeStop();
      else await MetronomeStart();
    } catch (e) {
      logger.error("metronome toggle failed", e);
    }
  }

  return (
    <footer class="dock" aria-label="Transport">
      <div class="dock-song">
        <Link class="dock-art" href="/player" aria-label="Open the player">
          <Icon name="lucide:music" />
        </Link>
        <div class="dock-text">
          <LiveText class="dock-title" text={titleText()} />
          <LiveText class="dock-sub" text={subText()} />
        </div>
      </div>

      <div class="dock-transport">
        <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Back to the start" disabled={!st().loaded} onClick={restart}>
          <Icon name="lucide:skip-back" />
        </button>
        <button class="krate-button krate-button-primary krate-button-icon" type="button" aria-label="Play or pause" disabled={!st().loaded} onClick={togglePlay}>
          <PlayGlyph on={st().playing} />
        </button>
        <LiveText class="dock-clock mono" text={clockText()} />
        <input
          class="seek"
          type="range"
          min="0"
          max={String(Math.max(1, st().durationMs))}
          step="100"
          aria-label="Position"
          disabled={!st().loaded}
          value={String(seek())}
          onInput={(e: Event) => {
            setDragging(true);
            setSeek(Number((e.target as HTMLInputElement).value));
          }}
          onChange={(e: Event) => {
            const ms = Number((e.target as HTMLInputElement).value);
            PlayerSeek(ms)
              .catch((err) => logger.error("seek failed", err))
              .finally(() => setDragging(false));
          }}
        />
        <LiveText class="dock-clock mono" text={lengthText()} />
      </div>

      <div class="dock-metro">
        <div class="beat-dots" aria-hidden="true">
          {cfg().accents.map((level, i) => (
            <span class="beat-dot" key={i} data-level={String(level)} data-on={beat() === i ? "true" : "false"} />
          ))}
        </div>
        <Link class="dock-bpm" href="/metronome" aria-label="Open the metronome">
          <LiveText class="dock-bpm-value mono" text={bpmText()} />
          <span class="dock-bpm-unit">BPM</span>
        </Link>
        <button class="krate-button krate-button-secondary krate-button-icon" type="button" aria-label="Start or stop the metronome" onClick={toggleMetronome}>
          <RunGlyph on={audio().metronome.running} />
        </button>
      </div>
    </footer>
  );
}
