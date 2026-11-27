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
  PlayerRenameSection,
  PlayerDeleteSection,
  PlayerStream,
} from "../../../api/player.go";
import { Waveform } from "./waveform";
import { FoldButton } from "../ui/fold-button";
import { Select } from "../ui/select";
import { Notice } from "../ui/notice";
import { LiveText } from "../ui/live-text";
import { askConfirm, askForm, askText } from "../../lib/modal";
import { clampNumber } from "../../lib/numbers";
import { currentPrefs, subscribePrefs } from "../../lib/prefs";
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

export interface PlayerDeckProps {
  onShowLibrary: () => void;
}

export function PlayerDeck(props: PlayerDeckProps) {
  const [st, setSt] = createSignal<PlayerState>(emptyPlayer);
  const [peaks, setPeaks] = createSignal<number[]>([]);
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [snap, setSnap] = createSignal<SnapMode>("beat");
  const [gridText, setGridText] = createSignal("No beat grid yet");
  const [showGrid, setShowGrid] = createSignal(true);
  const [sections, setSections] = createSignal<Section[]>([]);
  const [speedShown, setSpeedShown] = createSignal(100);
  const [pitchShown, setPitchShown] = createSignal(0);
  const [volumeShown, setVolumeShown] = createSignal(90);
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
    const s = st();
    setGridText(s.loaded && s.grid.bpm > 0 ? s.grid.bpm.toFixed(1) + " BPM, " + (s.grid.beatsPerBar || 4) + " beats per bar, beat one at " + Math.round(s.grid.offsetMs) + " ms" : "No beat grid yet");
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
    if (st().positionMs > currentPrefs().restartAfterSeconds * 1000) {
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
    let appliedSnap = "";
    onCleanup(
      subscribePrefs((p) => {
        setShowGrid(p.beatGrid);
        if (p.defaultSnap !== appliedSnap) {
          appliedSnap = p.defaultSnap;
          setSnap(p.defaultSnap as SnapMode);
        }
      }),
    );
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
        seekBy(-1000 * (e.shiftKey ? currentPrefs().seekLargeSeconds : currentPrefs().seekSeconds));
      } else if (e.key === "ArrowRight" && !onWave) {
        e.preventDefault();
        seekBy(1000 * (e.shiftKey ? currentPrefs().seekLargeSeconds : currentPrefs().seekSeconds));
      } else if (e.key === "l" || e.key === "L") {
        toggleLoop();
      } else if (e.key === "n" || e.key === "N") {
        next();
      } else if (e.key === "p" || e.key === "P") {
        previous();
      } else if (e.key === "-") {
        stepSpeed(-currentPrefs().speedStep);
      } else if (e.key === "=" || e.key === "+") {
        stepSpeed(currentPrefs().speedStep);
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
    const l = st().loop;
    if (l.endMs <= l.startMs) {
      setError("Choose a loop first, then save it as a section.");
      return;
    }
    const name = await askText({
      title: "Save loop",
      message: formatClock(l.startMs) + " to " + formatClock(l.endMs),
      label: "Section name",
      confirmLabel: "Save loop",
      placeholder: "Chorus",
      suggestions: SECTION_NAMES,
      maxLength: 40,
    });
    if (!name) return;
    await guard(async () => {
      await PlayerSaveSection(name, l.startMs, l.endMs);
      await loadSections();
    });
  }

  async function renameSection(section: Section) {
    const name = await askText({ title: "Rename section", label: "Section name", confirmLabel: "Rename", value: section.name, suggestions: SECTION_NAMES, maxLength: 40 });
    if (!name || name === section.name) return;
    await guard(async () => {
      await PlayerRenameSection(section.id, name);
      await loadSections();
    });
  }

  async function deleteSection(section: Section) {
    const yes = await askConfirm({ title: "Delete section", message: "Delete the section " + section.name + "? The song is not changed.", confirmLabel: "Delete section", danger: true });
    if (!yes) return;
    await guard(async () => {
      await PlayerDeleteSection(section.id);
      await loadSections();
    });
  }

  async function editGrid() {
    if (!st().loaded) return;
    const g = st().grid;
    const values = await askForm({
      title: "Edit beat grid",
      confirmLabel: "Apply",
      fields: [
        { key: "bpm", label: "Tempo in BPM (20 to 400)", type: "decimal", value: g.bpm > 0 ? String(Math.round(g.bpm * 100) / 100) : "120", required: true },
        { key: "offset", label: "Beat one position in milliseconds", type: "decimal", value: String(Math.round(g.offsetMs)) },
        { key: "beats", label: "Beats per bar (1 to 32)", type: "decimal", value: String(g.beatsPerBar || 4) },
        { key: "downbeat", label: "Downbeat", type: "decimal", value: String(g.downbeat || 0) },
      ],
    });
    if (!values) return;
    const bpm = clampNumber(values.bpm, 20, 400, 2);
    if (bpm === null) {
      setError("Enter the tempo as a number.");
      return;
    }
    const beats = clampNumber(values.beats, 1, 32, 0) ?? 4;
    const offset = clampNumber(values.offset, 0, 3600000, 0) ?? 0;
    const downbeat = clampNumber(values.downbeat, 0, beats - 1, 0) ?? 0;
    guard(async () => {
      await PlayerSetGrid(bpm, offset, beats, downbeat);
      setInfo("Beat grid saved.");
    });
  }

  function detectGrid() {
    guard(async () => {
      const g = await PlayerDetectGrid();
      setInfo("Tempo detected: " + g.bpm.toFixed(1) + " BPM.");
    });
  }

  function markBeatOne() {
    const g = st().grid;
    if (g.bpm <= 0) {
      setError("Set or detect the tempo first.");
      return;
    }
    const offset = Math.round(st().positionMs % (60000 / g.bpm));
    guard(async () => {
      await PlayerSetGrid(g.bpm, offset, g.beatsPerBar || 4, g.downbeat || 0);
      setInfo("Beat one moved to the playhead.");
    });
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
          <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={props.onShowLibrary}>
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
            showGrid={showGrid()}
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
                <button class="section-chip-x" type="button" aria-label={"Rename " + s.name} data-tip="Rename this section" onClick={() => renameSection(s)}>
                  <Icon name="lucide:pencil" />
                </button>
                <button class="section-chip-x" type="button" aria-label={"Delete " + s.name} data-tip="Delete this section" onClick={() => deleteSection(s)}>
                  <Icon name="lucide:trash-2" />
                </button>
              </span>
            ))}
          </div>
          <button class="krate-button krate-button-secondary krate-button-sm foot-action" type="button" disabled={!st().loop.enabled} data-tip="Save the current loop as a section" onClick={saveSection}>
            <Icon name="lucide:bookmark-plus" />
            Save loop
          </button>
        </div>

        <div class="foot-body" showIf={side() === "grid"}>
          <LiveText class="grid-summary mono" text={gridText()} />
          <div class="grid-actions">
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} data-tip="Find the tempo from the audio" onClick={detectGrid}>
              <Icon name="lucide:scan-search" />
              Detect
            </button>
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} data-tip="Move beat one to the playhead" onClick={markBeatOne}>
              <Icon name="lucide:flag" />
              Beat one here
            </button>
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} onClick={editGrid}>
              <Icon name="lucide:pencil" />
              Edit grid
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
          <button class="krate-button krate-button-secondary" type="button" data-tip="Reset speed and pitch" data-keys="0" onClick={resetTempo}>
            <Icon name="lucide:rotate-ccw" />
            Reset
          </button>
        </div>
      </footer>
    </section>
  );
}
