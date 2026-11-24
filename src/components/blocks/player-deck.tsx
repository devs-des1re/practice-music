import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import {
  PlayerCurrent,
  PlayerOpen,
  PlayerPlay,
  PlayerPause,
  PlayerSeek,
  PlayerSetSpeed,
  PlayerSetPitch,
  PlayerSetVolume,
  PlayerSetLoop,
  PlayerSetCountIn,
  PlayerSetGrid,
  PlayerDetectGrid,
  PlayerSections,
  PlayerSaveSection,
  PlayerDeleteSection,
  PlayerStream,
} from "../../../api/player.go";
import { Waveform } from "./waveform";
import { FoldButton } from "../ui/fold-button";
import { Select } from "../ui/select";
import { Notice } from "../ui/notice";
import { LiveText } from "../ui/live-text";
import { PlayGlyph } from "../ui/glyphs";
import { barAndBeat, formatClock, type SnapMode } from "../../lib/waveform";
import { emptyPlayer } from "../../lib/player";
import { neighbour } from "../../lib/queue";
import { isTyping } from "../../lib/workspace";
import { handleError, logFailure } from "../../lib/service";
import type { PlayerState, Section } from "../../lib/types";

const SNAPS = [
  { value: "beat", label: "Snap to beats" },
  { value: "bar", label: "Snap to bars" },
  { value: "off", label: "No snapping" },
];

const COUNT_INS = [
  { value: "0", label: "No count-in" },
  { value: "1", label: "1 beat count-in" },
  { value: "2", label: "2 beat count-in" },
  { value: "4", label: "4 beat count-in" },
];

const PRESETS = [50, 60, 70, 80, 90, 100];
const SECTION_NAMES = ["Intro", "Verse", "Pre-chorus", "Chorus", "Bridge", "Fill", "Solo", "Outro"];
const RESTART_AFTER_MS = 3000;

export interface PlayerDeckProps {
  onShowLibrary: () => void;
}

export function PlayerDeck(props: PlayerDeckProps) {
  const [st, setSt] = createSignal<PlayerState>(emptyPlayer);
  const [peaks, setPeaks] = createSignal<number[]>([]);
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [snap, setSnap] = createSignal<SnapMode>("beat");
  const [sections, setSections] = createSignal<Section[]>([]);
  const [sectionName, setSectionName] = createSignal("");
  const [speedShown, setSpeedShown] = createSignal(100);
  const [pitchShown, setPitchShown] = createSignal(0);
  const [volumeShown, setVolumeShown] = createSignal(90);
  const [bpmEdit, setBpmEdit] = createSignal(120);
  const [offsetEdit, setOffsetEdit] = createSignal(0);
  const [beatsEdit, setBeatsEdit] = createSignal(4);
  const [downbeatEdit, setDownbeatEdit] = createSignal(0);
  const [side, setSide] = createSignal("sections");
  const [reading, setReading] = createSignal(false);
  const [titleText, setTitleText] = createSignal("");
  const [subText, setSubText] = createSignal("");
  const [timeText, setTimeText] = createSignal("0:00.0");
  const [barText, setBarText] = createSignal("-");
  const [tempoText, setTempoText] = createSignal("-");
  const [loopText, setLoopText] = createSignal("Off");
  const [speedText, setSpeedText] = createSignal("100%");
  const [pitchText, setPitchText] = createSignal("0 st");
  const [volumeText, setVolumeText] = createSignal("90%");
  let shownSong = -1;

  createEffect(() => {
    const next = PlayerStream();
    if (next) setSt(next);
  });

  createEffect(() => {
    const s = st();
    setSpeedShown(Math.round(s.speed * 100));
    setPitchShown(s.pitch);
    setVolumeShown(Math.round(s.volume * 100));
    setTitleText(s.loaded ? s.title || "Untitled" : "");
    setSubText(s.loaded ? s.artist || "Unknown artist" : "");
  });

  createEffect(() => {
    const s = st();
    const bb = barAndBeat(s.positionMs, s.grid);
    setTimeText(formatClock(s.positionMs));
    setBarText(s.loaded && s.grid.bpm > 0 ? bb.bar + "." + bb.beat : "-");
    setTempoText(s.loaded && s.grid.bpm > 0 ? (s.grid.bpm * s.speed).toFixed(1) : "-");
    setLoopText(s.loop.enabled ? "On " + s.loops : "Off");
  });

  createEffect(() => {
    const p = pitchShown();
    setSpeedText(speedShown() + "%");
    setPitchText((p > 0 ? "+" : "") + p + " st");
    setVolumeText(volumeShown() + "%");
  });

  createEffect(() => {
    const s = st();
    const id = s.loaded ? s.songId : 0;
    if (id === shownSong) return;
    shownSong = id;
    if (!id) {
      setPeaks([]);
      setSections([]);
      return;
    }
    setReading(true);
    PlayerCurrent()
      .then(async (restored) => {
        setPeaks(restored.peaks);
        syncGridFields(restored.grid);
        setInfo("");
        await loadSections();
      })
      .catch((e) => {
        logFailure("could not read the loaded song", e);
        handleError(e, setError);
      })
      .finally(() => setReading(false));
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logFailure("player action failed", e);
      handleError(e, setError);
    }
  }

  async function loadSections() {
    try {
      setSections(await PlayerSections());
    } catch (e) {
      logFailure("sections failed", e);
    }
  }

  function syncGridFields(g: PlayerState["grid"]) {
    if (g.bpm > 0) setBpmEdit(Math.round(g.bpm * 100) / 100);
    setOffsetEdit(Math.round(g.offsetMs));
    setBeatsEdit(g.beatsPerBar || 4);
    setDownbeatEdit(g.downbeat || 0);
  }

  function startOfPlay(): number {
    return st().loop.enabled ? st().loop.startMs : 0;
  }

  function togglePlay() {
    if (!st().loaded) return;
    guard(() => (st().playing ? PlayerPause() : PlayerPlay()));
  }

  function stop() {
    if (!st().loaded) return;
    guard(async () => {
      await PlayerPause();
      await PlayerSeek(startOfPlay());
    });
  }

  function seekBy(delta: number) {
    if (!st().loaded) return;
    const to = Math.min(st().durationMs, Math.max(0, st().positionMs + delta));
    guard(() => PlayerSeek(to));
  }

  function previous() {
    if (!st().loaded) return;
    if (st().positionMs > RESTART_AFTER_MS) {
      guard(() => PlayerSeek(startOfPlay()));
      return;
    }
    const id = neighbour(st().songId, -1);
    if (!id) {
      guard(() => PlayerSeek(startOfPlay()));
      return;
    }
    guard(() => PlayerOpen(id));
  }

  function next() {
    if (!st().loaded) return;
    const id = neighbour(st().songId, 1);
    if (!id) {
      setInfo("That is the last song in the list.");
      return;
    }
    setInfo("");
    guard(() => PlayerOpen(id));
  }

  function stepSpeed(delta: number) {
    if (!st().loaded) return;
    const pct = Math.min(200, Math.max(25, Math.round(st().speed * 100) + delta));
    guard(() => PlayerSetSpeed(pct / 100));
  }

  function resetTempo() {
    guard(async () => {
      await PlayerSetSpeed(1);
      await PlayerSetPitch(0);
    });
  }

  function toggleLoop() {
    const l = st().loop;
    if (l.endMs <= l.startMs) {
      setError("Drag on the timeline to choose a loop first.");
      return;
    }
    guard(() => PlayerSetLoop(l.startMs, l.endMs, !l.enabled));
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const onWave = (e.target as HTMLElement | null)?.id === "waveform";
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "Enter") {
        e.preventDefault();
        stop();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (st().loaded) guard(() => PlayerSeek(startOfPlay()));
      } else if (e.key === "ArrowLeft" && !onWave) {
        e.preventDefault();
        seekBy(e.shiftKey ? -15000 : -5000);
      } else if (e.key === "ArrowRight" && !onWave) {
        e.preventDefault();
        seekBy(e.shiftKey ? 15000 : 5000);
      } else if (e.key === "l" || e.key === "L") {
        toggleLoop();
      } else if (e.key === "n" || e.key === "N") {
        next();
      } else if (e.key === "p" || e.key === "P") {
        previous();
      } else if (e.key === "-") {
        stepSpeed(-5);
      } else if (e.key === "=" || e.key === "+") {
        stepSpeed(5);
      } else if (e.key === "0") {
        resetTempo();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function applySection(s: Section) {
    guard(async () => {
      await PlayerSetLoop(s.startMs, s.endMs, true);
      await PlayerSeek(s.startMs);
    });
  }

  async function saveSection() {
    const name = sectionName().trim();
    const l = st().loop;
    if (!name) {
      setError("Give the section a name.");
      return;
    }
    if (l.endMs <= l.startMs) {
      setError("Choose a loop first, then save it as a section.");
      return;
    }
    await guard(async () => {
      await PlayerSaveSection(name, l.startMs, l.endMs);
      setSectionName("");
      await loadSections();
    });
  }

  function applyGrid() {
    guard(async () => {
      const g = await PlayerSetGrid(bpmEdit(), offsetEdit(), beatsEdit(), downbeatEdit());
      syncGridFields(g);
      setInfo("Beat grid saved.");
    });
  }

  function detectGrid() {
    guard(async () => {
      const g = await PlayerDetectGrid();
      syncGridFields(g);
      setInfo("Tempo detected: " + g.bpm.toFixed(1) + " BPM.");
    });
  }

  function markBeatOne() {
    const beat = 60000 / Math.max(1, bpmEdit());
    setOffsetEdit(Math.round(st().positionMs % beat));
    setInfo("Beat one moved to the playhead. Press Apply to keep it.");
  }

  return (
    <section class="panel ws-panel player-panel" data-panel="player" aria-label="Player">
      <header class="transport" data-drag="true">
        <div class="tp-group">
          <button class="tp-btn" type="button" aria-label="Previous" data-tip="Restart or previous song" data-keys="P" disabled={!st().loaded} onClick={previous}>
            <Icon name="lucide:skip-back" />
          </button>
          <button class="tp-btn" type="button" aria-label="Stop" data-tip="Stop and return" data-keys="Enter" disabled={!st().loaded} onClick={stop}>
            <Icon name="lucide:square" />
          </button>
          <button class="tp-btn tp-play" type="button" aria-label="Play or pause" data-tip="Play or pause" data-keys="Space" data-on={st().playing ? "true" : "false"} disabled={!st().loaded} onClick={togglePlay}>
            <PlayGlyph on={st().playing} />
          </button>
          <button class="tp-btn" type="button" aria-label="Next" data-tip="Next song" data-keys="N" disabled={!st().loaded} onClick={next}>
            <Icon name="lucide:skip-forward" />
          </button>
          <span class="tp-gap" />
          <button class="tp-btn" type="button" aria-label="Loop on or off" data-tip="Loop on or off" data-keys="L" data-on={st().loop.enabled ? "true" : "false"} disabled={!st().loaded} onClick={toggleLoop}>
            <Icon name="lucide:repeat" />
          </button>
          <button class="tp-btn" type="button" aria-label="Clear the loop" data-tip="Clear the loop" disabled={!st().loaded || st().loop.endMs <= st().loop.startMs} onClick={() => guard(() => PlayerSetLoop(0, 0, false))}>
            <Icon name="lucide:eraser" />
          </button>
        </div>

        <div class="lcd" aria-label="Position">
          <div class="lcd-cell">
            <span class="lcd-label">Time</span>
            <LiveText class="lcd-value" text={timeText()} />
          </div>
          <div class="lcd-cell">
            <span class="lcd-label">Bar</span>
            <LiveText class="lcd-value" text={barText()} />
          </div>
          <div class="lcd-cell">
            <span class="lcd-label">Tempo</span>
            <LiveText class="lcd-value" text={tempoText()} />
          </div>
          <div class="lcd-cell">
            <span class="lcd-label">Loop</span>
            <LiveText class="lcd-value" text={loopText()} />
          </div>
        </div>

        <div class="tp-params">
          <div class="param">
            <span class="param-label">Speed</span>
            <input
              id="speed"
              class="range"
              type="range"
              min="25"
              max="200"
              step="1"
              aria-label="Speed"
              data-tip="Playback speed. Double-click to reset."
              disabled={!st().loaded}
              value={String(speedShown())}
              onInput={(e: Event) => setSpeedShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => guard(() => PlayerSetSpeed(Number((e.target as HTMLInputElement).value) / 100))}
              onDoubleClick={() => guard(() => PlayerSetSpeed(1))}
            />
            <LiveText class="param-value" text={speedText()} />
          </div>
          <div class="param">
            <span class="param-label">Pitch</span>
            <input
              id="pitch"
              class="range"
              type="range"
              min="-12"
              max="12"
              step="1"
              aria-label="Pitch in semitones"
              data-tip="Pitch in semitones. Double-click to reset."
              disabled={!st().loaded}
              value={String(pitchShown())}
              onInput={(e: Event) => setPitchShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => guard(() => PlayerSetPitch(Number((e.target as HTMLInputElement).value)))}
              onDoubleClick={() => guard(() => PlayerSetPitch(0))}
            />
            <LiveText class="param-value" text={pitchText()} />
          </div>
          <div class="param">
            <span class="param-label">Volume</span>
            <input
              id="volume"
              class="range"
              type="range"
              min="0"
              max="120"
              step="1"
              aria-label="Song volume"
              data-tip="Song volume. Double-click to reset."
              disabled={!st().loaded}
              value={String(volumeShown())}
              onInput={(e: Event) => setVolumeShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => guard(() => PlayerSetVolume(Number((e.target as HTMLInputElement).value) / 100))}
              onDoubleClick={() => guard(() => PlayerSetVolume(0.9))}
            />
            <LiveText class="param-value" text={volumeText()} />
          </div>
        </div>
        <FoldButton />
      </header>

      <div class="panel-notices" showIf={!!error() || !!info()}>
        <div showIf={!!error()}>
          <Notice tone="bad" text={error()} />
        </div>
        <div showIf={!!info() && !error()}>
          <Notice tone="ok" text={info()} />
        </div>
      </div>

      <div class="timeline-bar">
        <div class="tp-song">
          <LiveText class="tp-title" text={titleText()} />
          <LiveText class="tp-artist" text={subText()} />
        </div>
        <div class="timeline-options">
          <Select id="count-in" label="Count-in" value={String(st().countIn)} options={COUNT_INS} onChange={(v) => guard(() => PlayerSetCountIn(Number(v)))} />
          <Select id="snap" label="Snapping" value={snap()} options={SNAPS} onChange={(v) => setSnap(v as SnapMode)} />
        </div>
      </div>

      <div class="timeline">
        <div class="timeline-empty" data-on={!st().loaded ? "true" : "false"}>
          <span class="timeline-title">
            <Icon name="lucide:audio-waveform" />
            No song loaded
          </span>
          <span class="timeline-hint">Double-click a song in the library to load it.</span>
          <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={props.onShowLibrary}>
            <Icon name="lucide:library-big" />
            Show library
          </button>
        </div>
        <div class="timeline-empty" data-on={st().loaded && reading() ? "true" : "false"}>
          <span class="timeline-title">
            <Icon name="lucide:loader" />
            Reading the waveform
          </span>
        </div>
        <div class="timeline-inner" showIf={st().loaded}>
          <Waveform
            peaks={peaks()}
            durationMs={st().durationMs}
            positionMs={st().positionMs}
            loopStart={st().loop.startMs}
            loopEnd={st().loop.endMs}
            loopOn={st().loop.enabled}
            gridBpm={st().grid.bpm}
            gridOffset={st().grid.offsetMs}
            gridBeats={st().grid.beatsPerBar}
            gridDownbeat={st().grid.downbeat}
            snap={snap()}
            markers={sections().map((s) => ({ name: s.name, startMs: s.startMs, endMs: s.endMs }))}
            onSeek={(ms) => guard(() => PlayerSeek(ms))}
            onLoop={(s, e) => guard(() => PlayerSetLoop(s, e, true))}
            onMarker={(i) => {
              const target = sections()[i];
              if (target) applySection(target);
            }}
          />
        </div>
      </div>

      <footer class="deck-foot">
        <div class="foot-tabs tabs">
          <button class="tab" type="button" data-active={side() === "sections" ? "true" : "false"} onClick={() => setSide("sections")}>
            Sections
          </button>
          <button class="tab" type="button" data-active={side() === "grid" ? "true" : "false"} onClick={() => setSide("grid")}>
            Beat grid
          </button>
          <button class="tab" type="button" data-active={side() === "practice" ? "true" : "false"} onClick={() => setSide("practice")}>
            Tempo
          </button>
        </div>

        <div class="foot-body" showIf={side() === "sections"}>
          <div class="section-chips">
            <span class="field-hint" showIf={sections().length === 0}>
              Drag on the timeline to make a loop, then save it here.
            </span>
            {sections().map((s) => (
              <span class="section-chip" key={s.id}>
                <button class="section-chip-main" type="button" data-tip={formatClock(s.startMs) + " to " + formatClock(s.endMs)} onClick={() => applySection(s)}>
                  {s.name}
                </button>
                <button
                  class="section-chip-x"
                  type="button"
                  aria-label={"Delete " + s.name}
                  data-tip="Delete this section"
                  onClick={() =>
                    guard(async () => {
                      await PlayerDeleteSection(s.id);
                      await loadSections();
                    })
                  }
                >
                  <Icon name="lucide:x" />
                </button>
              </span>
            ))}
          </div>
          <div class="inline-form">
            <input
              class="krate-input"
              type="text"
              list="section-names"
              placeholder="Name this loop"
              aria-label="Section name"
              value={sectionName()}
              onInput={(e: Event) => setSectionName((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") saveSection();
              }}
            />
            <datalist id="section-names">
              {SECTION_NAMES.map((n) => (
                <option value={n} key={n} />
              ))}
            </datalist>
            <button class="krate-button krate-button-secondary" type="button" disabled={!st().loop.enabled} onClick={saveSection}>
              <Icon name="lucide:bookmark" />
              Save section
            </button>
          </div>
        </div>

        <div class="foot-body" showIf={side() === "grid"}>
          <div class="grid-fields">
            <label class="grid-field">
              BPM
              <input class="krate-input" type="number" min="20" max="400" step="0.1" aria-label="Beats per minute" value={String(bpmEdit())} onInput={(e: Event) => setBpmEdit(Number((e.target as HTMLInputElement).value))} />
            </label>
            <label class="grid-field">
              Beat one ms
              <input class="krate-input" type="number" min="0" step="1" aria-label="Beat one position in milliseconds" value={String(offsetEdit())} onInput={(e: Event) => setOffsetEdit(Number((e.target as HTMLInputElement).value))} />
            </label>
            <label class="grid-field">
              Beats
              <input class="krate-input" type="number" min="1" max="32" step="1" aria-label="Beats per bar" value={String(beatsEdit())} onInput={(e: Event) => setBeatsEdit(Number((e.target as HTMLInputElement).value))} />
            </label>
            <label class="grid-field">
              Downbeat
              <input class="krate-input" type="number" min="0" max="31" step="1" aria-label="Downbeat" value={String(downbeatEdit())} onInput={(e: Event) => setDownbeatEdit(Number((e.target as HTMLInputElement).value))} />
            </label>
          </div>
          <div class="grid-fields">
            <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={detectGrid}>
              <Icon name="lucide:scan-search" />
              Detect
            </button>
            <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={markBeatOne}>
              <Icon name="lucide:flag" />
              Beat one here
            </button>
            <button class="krate-button krate-button-primary" type="button" disabled={!st().loaded} onClick={applyGrid}>
              <Icon name="lucide:check" />
              Apply
            </button>
          </div>
        </div>

        <div class="foot-body" showIf={side() === "practice"}>
          <span class="field-hint">Play at</span>
          <div class="segmented">
            {PRESETS.map((p) => (
              <button class="segment" type="button" key={p} data-active={speedShown() === p ? "true" : "false"} data-tip={"Play at " + p + " percent"} onClick={() => guard(() => PlayerSetSpeed(p / 100))}>
                {p + "%"}
              </button>
            ))}
          </div>
          <button class="krate-button krate-button-ghost" type="button" data-tip="Reset speed and pitch" data-keys="0" onClick={resetTempo}>
            <Icon name="lucide:rotate-ccw" />
            Reset
          </button>
        </div>
      </footer>
    </section>
  );
}
