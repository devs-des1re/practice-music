import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import {
  PlayerCurrent,
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
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import { Notice } from "../ui/notice";
import { Readout } from "../ui/readout";
import { LiveText } from "../ui/live-text";
import { PlayGlyph } from "../ui/glyphs";
import { barAndBeat, formatClock, type SnapMode } from "../../lib/waveform";
import { emptyPlayer } from "../../lib/player";
import { isTyping } from "../../lib/workspace";
import { logger } from "../../lib/logger";
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

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  const [bpmEdit, setBpmEdit] = createSignal(120);
  const [offsetEdit, setOffsetEdit] = createSignal(0);
  const [beatsEdit, setBeatsEdit] = createSignal(4);
  const [downbeatEdit, setDownbeatEdit] = createSignal(0);
  const [side, setSide] = createSignal("sections");
  const [titleText, setTitleText] = createSignal("No song loaded");
  const [subText, setSubText] = createSignal("Pick a song in the library to start");
  let shownSong = -1;

  createEffect(() => {
    const next = PlayerStream();
    if (next) setSt(next);
  });

  createEffect(() => {
    const s = st();
    setSpeedShown(Math.round(s.speed * 100));
    setPitchShown(s.pitch);
    setTitleText(s.loaded ? s.title || "Untitled" : "No song loaded");
    setSubText(s.loaded ? s.artist || "Unknown artist" : "Pick a song in the library to start");
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
    PlayerCurrent()
      .then(async (restored) => {
        setPeaks(restored.peaks);
        syncGridFields(restored.grid);
        setInfo("");
        await loadSections();
      })
      .catch((e) => {
        logger.error("could not read the loaded song", e);
        setError(describe(e));
      });
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logger.error("player action failed", e);
      setError(describe(e));
    }
  }

  async function loadSections() {
    try {
      setSections(await PlayerSections());
    } catch (e) {
      logger.error("sections failed", e);
    }
  }

  function syncGridFields(g: PlayerState["grid"]) {
    if (g.bpm > 0) setBpmEdit(Math.round(g.bpm * 100) / 100);
    setOffsetEdit(Math.round(g.offsetMs));
    setBeatsEdit(g.beatsPerBar || 4);
    setDownbeatEdit(g.downbeat || 0);
  }

  function togglePlay() {
    if (!st().loaded) return;
    guard(() => (st().playing ? PlayerPause() : PlayerPlay()));
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function toggleLoop() {
    const l = st().loop;
    if (l.endMs <= l.startMs) {
      setError("Drag on the waveform to choose a loop first.");
      return;
    }
    guard(() => PlayerSetLoop(l.startMs, l.endMs, !l.enabled));
  }

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
    <section class="deck player-deck" data-hue="player" aria-label="Player">
      <header class="deck-head" data-drag="true">
        <span class="deck-icon">
          <Icon name="lucide:audio-waveform" />
        </span>
        <div class="deck-song">
          <LiveText class="deck-title" text={titleText()} />
          <LiveText class="deck-sub" text={subText()} />
        </div>
        <div class="deck-stats" showIf={st().loaded}>
          <Readout label="Tempo" value={st().grid.bpm > 0 ? (st().grid.bpm * st().speed).toFixed(1) : "-"} />
          <Readout label="Position" value={formatClock(st().positionMs) + " / " + formatClock(st().durationMs)} />
          <Readout label="Bar" value={st().grid.bpm > 0 ? barAndBeat(st().positionMs, st().grid).bar + "." + barAndBeat(st().positionMs, st().grid).beat : "-"} />
          <Readout label="Speed" value={Math.round(st().speed * 100) + "%"} />
          <Readout label="Loop" value={st().loop.enabled ? "On, " + st().loops : "Off"} />
        </div>
      </header>

      <div class="deck-notice" showIf={!!error()}>
        <Notice tone="bad" text={error()} />
      </div>
      <div class="deck-notice" showIf={!!info() && !error()}>
        <Notice tone="ok" text={info()} />
      </div>

      <div class="deck-wave">
        <div class="deck-empty" showIf={!st().loaded}>
          <Icon name="lucide:audio-waveform" />
          <span>No song loaded</span>
          <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={props.onShowLibrary}>
            <Icon name="lucide:library-big" />
            Open the library
          </button>
        </div>
        <div class="deck-wave-inner" showIf={st().loaded}>
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
            onSeek={(ms) => guard(() => PlayerSeek(ms))}
            onLoop={(s, e) => guard(() => PlayerSetLoop(s, e, true))}
          />
        </div>
      </div>

      <div class="deck-controls">
        <div class="ctrl-group transport-group">
          <div class="transport-buttons">
            <button class="krate-button krate-button-secondary krate-button-icon" type="button" aria-label="Back to the start" title="Back to the start" disabled={!st().loaded} onClick={() => guard(() => PlayerSeek(st().loop.enabled ? st().loop.startMs : 0))}>
              <Icon name="lucide:skip-back" />
            </button>
            <button class="krate-button krate-button-primary play-button" type="button" aria-label="Play or pause" title="Play or pause (Space)" disabled={!st().loaded} onClick={togglePlay}>
              <PlayGlyph on={st().playing} offLabel="Play" onLabel="Pause" />
            </button>
            <button class="krate-button krate-button-secondary krate-button-icon" type="button" aria-label="Loop on or off" title="Loop on or off" data-on={st().loop.enabled ? "true" : "false"} disabled={!st().loaded} onClick={toggleLoop}>
              <Icon name="lucide:repeat" />
            </button>
            <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Clear the loop" title="Clear the loop" disabled={!st().loaded} onClick={() => guard(() => PlayerSetLoop(0, 0, false))}>
              <Icon name="lucide:x" />
            </button>
          </div>
          <Select id="count-in" label="Count-in" value={String(st().countIn)} options={COUNT_INS} onChange={(v) => guard(() => PlayerSetCountIn(Number(v)))} />
          <Select id="snap" label="Snapping" value={snap()} options={SNAPS} onChange={(v) => setSnap(v as SnapMode)} />
        </div>

        <div class="ctrl-group">
          <div class="ctrl-line">
            <span class="ctrl-label">Speed</span>
            <input
              id="speed"
              class="range"
              type="range"
              min="25"
              max="200"
              step="1"
              aria-label="Speed"
              value={String(speedShown())}
              onInput={(e: Event) => setSpeedShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => guard(() => PlayerSetSpeed(Number((e.target as HTMLInputElement).value) / 100))}
            />
            <LiveText class="ctrl-value" text={speedShown() + "%"} />
          </div>
          <div class="segmented full">
            {PRESETS.map((p) => (
              <button class="segment" type="button" key={p} data-active={speedShown() === p ? "true" : "false"} onClick={() => guard(() => PlayerSetSpeed(p / 100))}>
                {p + "%"}
              </button>
            ))}
          </div>
          <div class="ctrl-line">
            <span class="ctrl-label">Pitch</span>
            <input
              id="pitch"
              class="range"
              type="range"
              min="-12"
              max="12"
              step="1"
              aria-label="Pitch in semitones"
              value={String(pitchShown())}
              onInput={(e: Event) => setPitchShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => guard(() => PlayerSetPitch(Number((e.target as HTMLInputElement).value)))}
            />
            <LiveText class="ctrl-value" text={(pitchShown() > 0 ? "+" : "") + pitchShown() + " st"} />
          </div>
          <div class="ctrl-line">
            <span class="ctrl-label">Volume</span>
            <input
              id="volume"
              class="range"
              type="range"
              min="0"
              max="1.2"
              step="0.01"
              aria-label="Song volume"
              value={String(st().volume)}
              onChange={(e: Event) => guard(() => PlayerSetVolume(Number((e.target as HTMLInputElement).value)))}
            />
            <button
              class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
              type="button"
              aria-label="Reset speed and pitch"
              title="Reset speed and pitch"
              onClick={() =>
                guard(async () => {
                  await PlayerSetSpeed(1);
                  await PlayerSetPitch(0);
                })
              }
            >
              <Icon name="lucide:rotate-ccw" />
            </button>
          </div>
        </div>

        <div class="ctrl-group side-group">
          <div class="segmented">
            <button class="segment" type="button" data-active={side() === "sections" ? "true" : "false"} onClick={() => setSide("sections")}>
              Sections
            </button>
            <button class="segment" type="button" data-active={side() === "grid" ? "true" : "false"} onClick={() => setSide("grid")}>
              Beat grid
            </button>
          </div>

          <div class="side-pane" showIf={side() === "sections"}>
            <div class="section-chips">
              <span class="field-hint" showIf={sections().length === 0}>
                Drag on the waveform to make a loop, then save it here.
              </span>
              {sections().map((s) => (
                <span class="section-chip" key={s.id}>
                  <button class="section-chip-main" type="button" title={formatClock(s.startMs) + " to " + formatClock(s.endMs)} onClick={() => applySection(s)}>
                    {s.name}
                  </button>
                  <button
                    class="section-chip-x"
                    type="button"
                    aria-label={"Delete " + s.name}
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
                Save
              </button>
            </div>
          </div>

          <div class="side-pane" showIf={side() === "grid"}>
            <div class="grid-fields">
              <Field label="BPM" htmlFor="grid-bpm">
                <input id="grid-bpm" class="krate-input" type="number" min="20" max="400" step="0.1" value={String(bpmEdit())} onInput={(e: Event) => setBpmEdit(Number((e.target as HTMLInputElement).value))} />
              </Field>
              <Field label="Beat one (ms)" htmlFor="grid-offset">
                <input id="grid-offset" class="krate-input" type="number" min="0" step="1" value={String(offsetEdit())} onInput={(e: Event) => setOffsetEdit(Number((e.target as HTMLInputElement).value))} />
              </Field>
              <Field label="Beats" htmlFor="grid-beats">
                <input id="grid-beats" class="krate-input" type="number" min="1" max="32" step="1" value={String(beatsEdit())} onInput={(e: Event) => setBeatsEdit(Number((e.target as HTMLInputElement).value))} />
              </Field>
              <Field label="Downbeat" htmlFor="grid-down">
                <input id="grid-down" class="krate-input" type="number" min="0" max="31" step="1" value={String(downbeatEdit())} onInput={(e: Event) => setDownbeatEdit(Number((e.target as HTMLInputElement).value))} />
              </Field>
            </div>
            <div class="grid-actions">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} onClick={detectGrid}>
                <Icon name="lucide:scan-search" />
                Detect
              </button>
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} onClick={markBeatOne}>
                <Icon name="lucide:flag" />
                Beat one here
              </button>
              <button class="krate-button krate-button-primary krate-button-sm" type="button" disabled={!st().loaded} onClick={applyGrid}>
                <Icon name="lucide:check" />
                Apply
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
