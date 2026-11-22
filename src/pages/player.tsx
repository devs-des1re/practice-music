import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import {
  PlayerOpen,
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
} from "../../api/player.go";
import { Waveform } from "../components/blocks/waveform";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Notice } from "../components/ui/notice";
import { Readout } from "../components/ui/readout";
import { barAndBeat, formatClock, type SnapMode } from "../lib/waveform";
import { emptyPlayer } from "../lib/player";
import { PlayGlyph } from "../components/ui/glyphs";
import { logger } from "../lib/logger";
import type { PlayerState, Section } from "../lib/types";

const SNAPS = [
  { value: "beat", label: "Snap to beats" },
  { value: "bar", label: "Snap to bars" },
  { value: "off", label: "No snapping" },
];

const COUNT_INS = [
  { value: "0", label: "No count-in" },
  { value: "1", label: "1 beat" },
  { value: "2", label: "2 beats" },
  { value: "4", label: "4 beats" },
];

const PRESETS = [50, 60, 70, 80, 90, 100];
const SECTION_NAMES = ["Intro", "Verse", "Pre-chorus", "Chorus", "Bridge", "Fill", "Solo", "Outro"];

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function PlayerPage() {
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
  const [opening, setOpening] = createSignal(true);

  createEffect(() => {
    const next = PlayerStream();
    if (next) setSt(next);
  });

  createEffect(() => {
    const s = st();
    setSpeedShown(Math.round(s.speed * 100));
    setPitchShown(s.pitch);
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

  onMount(async () => {
    const id = Number(new URLSearchParams(location.search).get("song") || 0);
    try {
      const restored = await PlayerCurrent();
      const live = PlayerStream() || st();
      if (live.loaded && (!id || live.songId === id)) {
        setPeaks(restored.peaks);
        syncGridFields(restored.grid);
        await loadSections();
      } else if (id) {
        const opened = await PlayerOpen(id);
        setPeaks(opened.peaks);
        syncGridFields(opened.grid);
        await loadSections();
      }
    } catch (e) {
      logger.error("could not open the song", e);
      setError(describe(e));
    } finally {
      setOpening(false);
    }
  });

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const tag = target ? target.tagName : "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function togglePlay() {
    guard(() => (st().playing ? PlayerPause() : PlayerPlay()));
  }

  function setLoop(start: number, end: number) {
    guard(() => PlayerSetLoop(start, end, true));
  }

  function toggleLoop() {
    const l = st().loop;
    if (l.endMs <= l.startMs) {
      setError("Drag on the waveform to choose a loop first.");
      return;
    }
    guard(() => PlayerSetLoop(l.startMs, l.endMs, !l.enabled));
  }

  function clearLoop() {
    guard(() => PlayerSetLoop(0, 0, false));
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
    setInfo("The first beat now sits at the playhead. Press Apply grid to keep it.");
  }

  return (
    <main class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">
            <Icon name="lucide:audio-waveform" />
            <span class="page-title-text">{st().loaded ? st().title : "Player"}</span>
          </h1>
          <p class="page-sub" showIf={st().loaded && !!st().artist}>
            {st().artist}
          </p>
        </div>
        <div class="stat-strip" showIf={st().loaded}>
          <div class="stat">
            <Readout label="Tempo" size="display" value={st().grid.bpm > 0 ? (st().grid.bpm * st().speed).toFixed(1) : "-"} />
          </div>
          <div class="stat">
            <Readout label="Position" size="display" value={formatClock(st().positionMs)} />
          </div>
          <div class="stat">
            <Readout label="Bar and beat" size="display" value={st().grid.bpm > 0 ? barAndBeat(st().positionMs, st().grid).bar + " : " + barAndBeat(st().positionMs, st().grid).beat : "-"} />
          </div>
          <div class="stat">
            <Readout label="Speed" size="display" value={Math.round(st().speed * 100) + "%"} />
          </div>
          <div class="stat">
            <Readout label="Loop" size="display" value={st().loop.enabled ? "On, " + st().loops : "Off"} />
          </div>
        </div>
      </header>

      <div showIf={!!error()}>
        <Notice tone="bad" text={error()} />
      </div>
      <div showIf={!!info() && !error()}>
        <Notice tone="ok" text={info()} />
      </div>
      <div showIf={opening()}>
        <Notice tone="info" text="Decoding and analysing the audio." />
      </div>

      <div class="fill" showIf={!st().loaded && !opening()}>
        <Panel hue="player">
          <div class="empty-state">
            <span class="empty-icon">
              <Icon name="lucide:audio-waveform" />
            </span>
            <span class="empty-title">No song loaded</span>
            <Link class="krate-button krate-button-primary" href="/library">
              <Icon name="lucide:library-big" />
              Choose from the library
            </Link>
          </div>
        </Panel>
      </div>

      <div class="fill player-ws" showIf={st().loaded}>
        <Panel hue="player">
          <div class="panel-body wave">
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
              onLoop={(s, e) => setLoop(s, e)}
            />
          </div>
        </Panel>

        <div class="deck">
          <Panel hue="player">
            <PanelHead title="Transport" />
            <PanelBody>
              <button class="krate-button krate-button-primary krate-button-lg" type="button" aria-label="Play or pause" disabled={!st().loaded} onClick={togglePlay}>
                <PlayGlyph on={st().playing} offLabel="Play" onLabel="Pause" />
              </button>
              <div class="btn-row">
                <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={() => guard(() => PlayerSeek(st().loop.enabled ? st().loop.startMs : 0))}>
                  <Icon name="lucide:skip-back" />
                  Restart
                </button>
                <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={toggleLoop}>
                  <Icon name="lucide:repeat" />
                  Loop
                </button>
                <button class="krate-button krate-button-ghost" type="button" disabled={!st().loaded} onClick={clearLoop}>
                  <Icon name="lucide:x" />
                  Clear
                </button>
              </div>
              <div class="field-row compact">
                <Select id="count-in" label="Count-in" value={String(st().countIn)} options={COUNT_INS} onChange={(v) => guard(() => PlayerSetCountIn(Number(v)))} />
                <Select id="snap" label="Snapping" value={snap()} options={SNAPS} onChange={(v) => setSnap(v as SnapMode)} />
              </div>
              <p class="field-hint">
                <span class="kbd">Space</span> plays, <span class="kbd">Alt</span> skips snapping.
              </p>
            </PanelBody>
          </Panel>

          <Panel hue="player">
            <PanelHead title="Speed and pitch">
              <button
                class="krate-button krate-button-ghost krate-button-sm"
                type="button"
                onClick={() =>
                  guard(async () => {
                    await PlayerSetSpeed(1);
                    await PlayerSetPitch(0);
                  })
                }
              >
                <Icon name="lucide:rotate-ccw" />
                Reset
              </button>
            </PanelHead>
            <PanelBody>
              <Field label={"Speed " + speedShown() + "%"} htmlFor="speed">
                <input
                  id="speed"
                  class="range"
                  type="range"
                  min="25"
                  max="200"
                  step="1"
                  value={String(speedShown())}
                  onInput={(e: Event) => setSpeedShown(Number((e.target as HTMLInputElement).value))}
                  onChange={(e: Event) => guard(() => PlayerSetSpeed(Number((e.target as HTMLInputElement).value) / 100))}
                />
              </Field>
              <div class="segmented full">
                {PRESETS.map((p) => (
                  <button class="segment" type="button" key={p} data-active={speedShown() === p ? "true" : "false"} onClick={() => guard(() => PlayerSetSpeed(p / 100))}>
                    {p + "%"}
                  </button>
                ))}
              </div>
              <Field label={"Pitch " + (pitchShown() > 0 ? "+" : "") + pitchShown() + " semitones"} htmlFor="pitch">
                <input
                  id="pitch"
                  class="range"
                  type="range"
                  min="-12"
                  max="12"
                  step="1"
                  value={String(pitchShown())}
                  onInput={(e: Event) => setPitchShown(Number((e.target as HTMLInputElement).value))}
                  onChange={(e: Event) => guard(() => PlayerSetPitch(Number((e.target as HTMLInputElement).value)))}
                />
              </Field>
              <Field label="Song volume" htmlFor="volume">
                <input
                  id="volume"
                  class="range"
                  type="range"
                  min="0"
                  max="1.2"
                  step="0.01"
                  value={String(st().volume)}
                  onChange={(e: Event) => guard(() => PlayerSetVolume(Number((e.target as HTMLInputElement).value)))}
                />
              </Field>
            </PanelBody>
          </Panel>

          <Panel hue="library">
            <PanelHead title="Sections" />
            <p class="empty" showIf={sections().length === 0}>
              No saved sections yet.
            </p>
            <div class="song-list">
              {sections().map((s) => (
                <div class="section-row" key={s.id}>
                  <button class="section-main" type="button" onClick={() => applySection(s)}>
                    <span class="song-title">{s.name}</span>
                    <span class="song-sub mono">{formatClock(s.startMs) + " to " + formatClock(s.endMs)}</span>
                  </button>
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Delete " + s.name} onClick={() => guard(async () => { await PlayerDeleteSection(s.id); await loadSections(); })}>
                    <Icon name="lucide:x" />
                  </button>
                </div>
              ))}
            </div>
            <div class="panel-body fixed compact">
              <div class="tag-row chip-scroll">
                {SECTION_NAMES.map((n) => (
                  <button class="tag-button" type="button" key={n} onClick={() => setSectionName(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <div class="inline-form">
                <input
                  class="krate-input"
                  type="text"
                  placeholder="Section name"
                  aria-label="Section name"
                  value={sectionName()}
                  onInput={(e: Event) => setSectionName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") saveSection();
                  }}
                />
                <button class="krate-button krate-button-secondary" type="button" disabled={!st().loop.enabled} onClick={saveSection}>
                  <Icon name="lucide:bookmark" />
                  Save
                </button>
              </div>
            </div>
          </Panel>

          <Panel hue="metronome">
            <PanelHead title="Beat grid">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} onClick={detectGrid}>
                <Icon name="lucide:scan-search" />
                Detect
              </button>
            </PanelHead>
            <PanelBody>
              <div class="field-row compact">
                <Field label="Tempo (BPM)" htmlFor="grid-bpm">
                  <input id="grid-bpm" class="krate-input" type="number" min="20" max="400" step="0.1" value={String(bpmEdit())} onInput={(e: Event) => setBpmEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
                <Field label="First beat (ms)" htmlFor="grid-offset">
                  <input id="grid-offset" class="krate-input" type="number" min="0" step="1" value={String(offsetEdit())} onInput={(e: Event) => setOffsetEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
              </div>
              <div class="field-row compact">
                <Field label="Beats per bar" htmlFor="grid-beats">
                  <input id="grid-beats" class="krate-input" type="number" min="1" max="32" step="1" value={String(beatsEdit())} onInput={(e: Event) => setBeatsEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
                <Field label="Bar starts on beat" htmlFor="grid-down">
                  <input id="grid-down" class="krate-input" type="number" min="0" max="31" step="1" value={String(downbeatEdit())} onInput={(e: Event) => setDownbeatEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
              </div>
              <div class="btn-row two">
                <button class="krate-button krate-button-primary" type="button" disabled={!st().loaded} onClick={applyGrid}>
                  <Icon name="lucide:check" />
                  Apply
                </button>
                <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={markBeatOne}>
                  <Icon name="lucide:flag" />
                  Beat one here
                </button>
              </div>
              <p class="field-hint">{st().grid.found ? (st().grid.userEdited ? "Set by hand." : "Detected, confidence " + Math.round(st().grid.confidence * 100) + "%.") : "No tempo yet."}</p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </main>
  );
}
