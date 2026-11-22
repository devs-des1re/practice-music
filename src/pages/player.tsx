import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import {
  PlayerOpen,
  PlayerClose,
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
import { logger } from "../lib/logger";
import type { PlayerState, Section } from "../lib/types";

const emptyState: PlayerState = {
  loaded: false,
  songId: 0,
  title: "",
  artist: "",
  path: "",
  durationMs: 0,
  positionMs: 0,
  playing: false,
  loops: 0,
  speed: 1,
  pitch: 0,
  volume: 0.9,
  loop: { startMs: 0, endMs: 0, enabled: false },
  countIn: 0,
  grid: { bpm: 0, offsetMs: 0, beatsPerBar: 4, downbeat: 0, confidence: 0, userEdited: false, found: false },
  error: "",
};

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
  const [st, setSt] = createSignal<PlayerState>(emptyState);
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
    if (!id) {
      setOpening(false);
      setError("Choose a song in the Library and press Open in player.");
      return;
    }
    try {
      const opened = await PlayerOpen(id);
      setPeaks(opened.peaks);
      syncGridFields(opened.grid);
      await loadSections();
    } catch (e) {
      logger.error("could not open the song", e);
      setError(describe(e));
    } finally {
      setOpening(false);
    }
  });

  onCleanup(() => {
    PlayerClose().catch(() => undefined);
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
      <div class="page-head">
        <div>
          <h1 class="page-title">{st().title || "Player"}</h1>
          <p class="page-sub">{st().artist || "Loop a section, slow it down and practise it."}</p>
        </div>
        <div class="actions">
          <Link class="krate-button krate-button-secondary" href="/library">
            <Icon name="lucide:library" />
            Library
          </Link>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Player" text={error()} />
      </div>
      <div showIf={!!info() && !error()}>
        <Notice tone="ok" title="Player" text={info()} />
      </div>
      <div showIf={opening()}>
        <Notice tone="info" title="Opening the song" text="Decoding and analysing the audio." />
      </div>

      <div class="player-readouts">
        <Readout label="Tempo" size="display" value={st().grid.bpm > 0 ? (st().grid.bpm * st().speed).toFixed(1) : "-"} />
        <Readout label="Position" size="display" value={formatClock(st().positionMs)} />
        <Readout label="Bar . beat" size="display" value={st().grid.bpm > 0 ? barAndBeat(st().positionMs, st().grid).bar + " . " + barAndBeat(st().positionMs, st().grid).beat : "-"} />
        <Readout label="Speed" size="display" value={Math.round(st().speed * 100) + "%"} />
        <Readout label="Loop" size="display" value={st().loop.enabled ? "On " + st().loops : "Off"} />
      </div>

      <Panel>
        <PanelHead title="Waveform">
          <div class="actions">
            <Select id="snap" label="Snapping" value={snap()} options={SNAPS} onChange={(v) => setSnap(v as SnapMode)} />
          </div>
        </PanelHead>
        <PanelBody>
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
          <div class="transport">
            <button class="krate-button krate-button-primary press-target" type="button" disabled={!st().loaded} onClick={togglePlay}>
              {st().playing ? "Pause" : "Play"}
            </button>
            <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={() => guard(() => PlayerSeek(st().loop.enabled ? st().loop.startMs : 0))}>
              <Icon name="lucide:skip-back" />
              {st().loop.enabled ? "Loop start" : "Start"}
            </button>
            <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={toggleLoop}>
              <Icon name="lucide:repeat" />
              {st().loop.enabled ? "Loop on" : "Loop off"}
            </button>
            <button class="krate-button krate-button-ghost" type="button" disabled={!st().loaded} onClick={clearLoop}>
              Clear loop
            </button>
            <Select
              id="count-in"
              label="Count-in"
              value={String(st().countIn)}
              options={COUNT_INS}
              onChange={(v) => guard(() => PlayerSetCountIn(Number(v)))}
            />
          </div>
          <p class="field-hint">
            Drag on the waveform to choose a loop, drag its edges to adjust, click to move the playhead. Hold Alt to ignore snapping. Space plays and pauses.
          </p>
        </PanelBody>
      </Panel>

      <div class="grid-2">
        <div class="stack">
          <Panel>
            <PanelHead title="Speed and pitch" />
            <PanelBody>
              <Field label={"Speed " + speedShown() + "%"} htmlFor="speed" hint="Changes tempo without changing pitch.">
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
              <div class="detail-actions">
                {PRESETS.map((p) => (
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" key={p} onClick={() => guard(() => PlayerSetSpeed(p / 100))}>
                    {p + "%"}
                  </button>
                ))}
              </div>
              <Field label={"Pitch " + (pitchShown() > 0 ? "+" : "") + pitchShown() + " semitones"} htmlFor="pitch" hint="Changes the key without changing tempo.">
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
              <div class="detail-actions">
                <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => guard(() => PlayerSetPitch(0))}>
                  Reset pitch
                </button>
              </div>
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

          <Panel>
            <PanelHead title="Beat grid">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!st().loaded} onClick={detectGrid}>
                Detect
              </button>
            </PanelHead>
            <PanelBody>
              <div class="field-row">
                <Field label="Tempo (BPM)" htmlFor="grid-bpm">
                  <input id="grid-bpm" class="krate-input" type="number" min="20" max="400" step="0.1" value={String(bpmEdit())} onInput={(e: Event) => setBpmEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
                <Field label="First beat (ms)" htmlFor="grid-offset">
                  <input id="grid-offset" class="krate-input" type="number" min="0" step="1" value={String(offsetEdit())} onInput={(e: Event) => setOffsetEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
              </div>
              <div class="field-row">
                <Field label="Beats per bar" htmlFor="grid-beats">
                  <input id="grid-beats" class="krate-input" type="number" min="1" max="32" step="1" value={String(beatsEdit())} onInput={(e: Event) => setBeatsEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
                <Field label="Bar starts on beat" htmlFor="grid-down" hint="0 is the first beat of the grid.">
                  <input id="grid-down" class="krate-input" type="number" min="0" max="31" step="1" value={String(downbeatEdit())} onInput={(e: Event) => setDownbeatEdit(Number((e.target as HTMLInputElement).value))} />
                </Field>
              </div>
              <div class="detail-actions">
                <button class="krate-button krate-button-primary" type="button" disabled={!st().loaded} onClick={applyGrid}>
                  Apply grid
                </button>
                <button class="krate-button krate-button-secondary" type="button" disabled={!st().loaded} onClick={markBeatOne}>
                  Beat one is at the playhead
                </button>
              </div>
              <p class="field-hint">{st().grid.found ? (st().grid.userEdited ? "Set by hand." : "Detected, confidence " + Math.round(st().grid.confidence * 100) + "%.") : "No tempo yet. Detect it or enter it by hand."}</p>
            </PanelBody>
          </Panel>
        </div>

        <div class="stack">
          <Panel>
            <PanelHead title="Sections" />
            <PanelBody>
              <p class="empty" showIf={sections().length === 0}>
                Save loops here, for example Verse, Chorus or Fill.
              </p>
              <div class="song-list">
                {sections().map((s) => (
                  <div class="section-row" key={s.id}>
                    <button class="section-main" type="button" onClick={() => applySection(s)}>
                      <span class="song-title">{s.name}</span>
                      <span class="song-sub mono">{formatClock(s.startMs) + " to " + formatClock(s.endMs)}</span>
                    </button>
                    <button class="krate-button krate-button-ghost krate-button-sm" type="button" aria-label={"Delete " + s.name} onClick={() => guard(async () => { await PlayerDeleteSection(s.id); await loadSections(); })}>
                      <Icon name="lucide:x" />
                    </button>
                  </div>
                ))}
              </div>
              <div class="tag-row">
                {SECTION_NAMES.map((n) => (
                  <button class="tag-button" type="button" key={n} onClick={() => setSectionName(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <div class="toolbar">
                <input
                  class="krate-input grow"
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
                  Save loop
                </button>
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </main>
  );
}
