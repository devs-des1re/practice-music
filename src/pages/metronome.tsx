import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { openFile } from "@krate/app/dialog";
import { AudioStream, StartAudio } from "../../api/audio.go";
import { Engine } from "../../api/host.go";
import {
  GetMetronome,
  SetMetronomeState,
  MetronomeStart,
  MetronomeStop,
  TapTempo,
  LoadMetronomeSound,
  ClearMetronomeSound,
  SessionEpoch,
  BeatStream,
} from "../../api/session.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Notice } from "../components/ui/notice";
import { Readout } from "../components/ui/readout";
import { LiveText } from "../components/ui/live-text";
import { SUBDIVISIONS, accentLabel, barCaption, cleanBpm, cycleAccent, polyLabel } from "../lib/mixer";
import { logger } from "../lib/logger";
import type { AudioState, MetronomeSetup } from "../lib/types";

const emptyCfg: MetronomeSetup = {
  bpm: 120,
  volume: 0.5,
  beatsPerBar: 4,
  subdivision: 1,
  subLevel: 0.55,
  accents: [3, 2, 2, 2],
  polyBeats: 0,
  polyLevel: 0.8,
  playBars: 1,
  silentBars: 0,
  sound: "click",
  customSounds: {},
};

const emptyAudio = {
  running: false,
  streamLatencyMs: 0,
  periodMs: 0,
  error: "",
  metronome: { running: false },
} as unknown as AudioState;

const SOUNDS = [
  { value: "click", label: "Click" },
  { value: "wood", label: "Wood block" },
  { value: "beep", label: "Beep" },
  { value: "hat", label: "Hi-hat" },
  { value: "cowbell", label: "Cowbell" },
];

const BEATS = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

const POLYS = [
  { value: "0", label: "Off" },
  ...Array.from({ length: 11 }, (_, i) => ({ value: String(i + 2), label: String(i + 2) })),
];

const ROLES = [
  { role: "accent", label: "Accent" },
  { role: "beat", label: "Beat" },
  { role: "sub", label: "Subdivision" },
  { role: "poly", label: "Polyrhythm" },
];

const AUDIO_PATTERNS = ["*.wav", "*.mp3", "*.flac", "*.ogg", "*.m4a", "*.opus"];

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function MetronomePage() {
  const [cfg, setCfg] = createSignal<MetronomeSetup>(emptyCfg);
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [shown, setShown] = createSignal({ beat: -1, bar: 0, level: 2, silent: false });
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [bpmText, setBpmText] = createSignal("120");
  const [volumeShown, setVolumeShown] = createSignal(50);
  const [subShown, setSubShown] = createSignal(55);
  const [polyShown, setPolyShown] = createSignal(80);
  const [taps, setTaps] = createSignal(0);
  const [numberText, setNumberText] = createSignal("-");
  const [captionText, setCaptionText] = createSignal("Press Start or the space bar");

  createEffect(() => {
    const next = AudioStream();
    if (next) setAudio(next);
  });

  const [engineState, setEngineState] = createSignal("");

  createEffect(() => {
    const next = Engine();
    if (next) setEngineState(next.state);
  });

  createEffect(() => {
    if (engineState() === "running" && !audio().running) {
      StartAudio()
        .then(() => setError(""))
        .catch((e) => setError(describe(e)));
    }
  });

  createEffect(() => {
    const c = cfg();
    setBpmText(String(c.bpm));
    setVolumeShown(Math.round(c.volume * 100));
    setSubShown(Math.round(c.subLevel * 100));
    setPolyShown(Math.round(c.polyLevel * 100));
  });

  createEffect(() => {
    SessionEpoch();
    GetMetronome()
      .then((next) => setCfg(next))
      .catch((e) => logger.error("metronome settings failed", e));
  });

  createEffect(() => {
    const frame = BeatStream();
    if (!frame || !audio().metronome.running) return;
    const lead = audio().streamLatencyMs > 0 ? audio().streamLatencyMs : audio().periodMs;
    const delay = Math.min(150, Math.max(0, lead || 0));
    const timer = setTimeout(() => setShown({ beat: frame.beat, bar: frame.bar, level: frame.level, silent: frame.silent }), delay);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const b = shown();
    setNumberText(b.beat >= 0 ? String(b.beat + 1) : "-");
    setCaptionText(b.beat >= 0 ? (b.silent ? "Silent bar. " : "") + barCaption(b.bar, b.beat, cfg().beatsPerBar) : "Press Start or the space bar");
  });

  createEffect(() => {
    if (!audio().metronome.running) setShown({ beat: -1, bar: 0, level: 2, silent: false });
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logger.error("metronome action failed", e);
      setError(describe(e));
    }
  }

  function update(patch: Record<string, unknown>) {
    const next = { ...cfg(), ...patch } as MetronomeSetup;
    setCfg(next);
    guard(async () => {
      const saved = await SetMetronomeState(next);
      setCfg(saved);
    });
  }

  function setTempo(value: number) {
    update({ bpm: cleanBpm(value) });
  }

  function nudge(delta: number) {
    setTempo(cfg().bpm + delta);
  }

  async function ensureAudio() {
    if (audio().running) return;
    await StartAudio();
  }

  function toggleRun() {
    guard(async () => {
      await ensureAudio();
      if (audio().metronome.running) await MetronomeStop();
      else await MetronomeStart();
    });
  }

  function tap() {
    guard(async () => {
      await ensureAudio();
      const res = await TapTempo();
      setTaps(res.taps);
      if (res.found) {
        setCfg({ ...cfg(), bpm: res.bpm });
      }
    });
  }

  function cycle(index: number) {
    const accents = cfg().accents.slice();
    accents[index] = cycleAccent(accents[index]);
    update({ accents });
  }

  function chooseSound(role: string) {
    guard(async () => {
      const files = await openFile({
        title: role === "all" ? "Choose a click sound" : "Choose a sound for " + role,
        filters: [{ name: "Audio", patterns: AUDIO_PATTERNS }],
      });
      if (files.length === 0) return;
      await ensureAudio();
      const next = await LoadMetronomeSound(role, files[0]);
      setCfg(next);
      setInfo("Custom sound loaded.");
    });
  }

  function resetSound(role: string) {
    guard(async () => {
      const next = await ClearMetronomeSound(role);
      setCfg(next);
    });
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target ? target.tagName : "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggleRun();
      } else if (e.key === "t" || e.key === "T") {
        tap();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        nudge(e.shiftKey ? 5 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        nudge(e.shiftKey ? -5 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Metronome</h1>
          <p class="page-sub">Accents, subdivisions, polyrhythms and silent bars, routed through the mixer.</p>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Metronome" text={error()} />
      </div>
      <div showIf={!!info() && !error()}>
        <Notice tone="ok" title="Metronome" text={info()} />
      </div>
      <div showIf={!audio().running && !error()}>
        <Notice tone="info" title="Audio engine" text="Starting the audio engine. The metronome needs it to make sound." />
      </div>

      <Panel>
        <PanelBody>
          <div class="beat-stage" data-silent={shown().silent ? "true" : "false"}>
            <LiveText class="beat-number" text={numberText()} level={String(shown().level)} on={shown().beat >= 0} />
            <LiveText class="beat-caption" text={captionText()} />
            <div class="beat-cells">
              {cfg().accents.map((level, i) => (
                <div class="beat-cell" key={i} data-level={String(level)} data-on={shown().beat === i ? "true" : "false"} data-silent={shown().silent ? "true" : "false"}>
                  {String(i + 1)}
                </div>
              ))}
            </div>
          </div>
        </PanelBody>
      </Panel>

      <div class="grid-2">
        <div class="stack">
          <Panel>
            <PanelHead title="Tempo" />
            <PanelBody>
              <div class="tempo-row">
                <button class="krate-button krate-button-secondary" type="button" onClick={() => nudge(-5)}>
                  -5
                </button>
                <button class="krate-button krate-button-secondary" type="button" onClick={() => nudge(-1)}>
                  -1
                </button>
                <Readout label="BPM" size="display" value={cfg().bpm.toFixed(cfg().bpm % 1 === 0 ? 0 : 1)} />
                <button class="krate-button krate-button-secondary" type="button" onClick={() => nudge(1)}>
                  +1
                </button>
                <button class="krate-button krate-button-secondary" type="button" onClick={() => nudge(5)}>
                  +5
                </button>
              </div>
              <div class="transport">
                <button class="krate-button krate-button-primary press-target" type="button" onClick={toggleRun}>
                  {audio().metronome.running ? "Stop" : "Start"}
                </button>
                <button class="krate-button krate-button-secondary press-target" type="button" onClick={tap}>
                  Tap tempo
                </button>
                <input
                  id="bpm"
                  class="krate-input tempo-input"
                  type="number"
                  min="20"
                  max="400"
                  step="0.1"
                  aria-label="Tempo in beats per minute"
                  value={bpmText()}
                  onInput={(e: Event) => setBpmText((e.target as HTMLInputElement).value)}
                  onChange={(e: Event) => setTempo(Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <p class="field-hint">
                {taps() > 1 ? "Tapped " + taps() + " times. " : ""}
                Space starts and stops, T taps, the arrow keys change the tempo.
              </p>
              <Field label={"Volume " + volumeShown() + "%"} htmlFor="met-volume">
                <input
                  id="met-volume"
                  class="range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={String(volumeShown())}
                  onInput={(e: Event) => setVolumeShown(Number((e.target as HTMLInputElement).value))}
                  onChange={(e: Event) => update({ volume: Number((e.target as HTMLInputElement).value) / 100 })}
                />
              </Field>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Bar" />
            <PanelBody>
              <div class="field-row">
                <Field label="Beats per bar" htmlFor="beats">
                  <Select id="beats" label="Beats per bar" value={String(cfg().beatsPerBar)} options={BEATS} onChange={(v) => update({ beatsPerBar: Number(v) })} />
                </Field>
                <Field label="Subdivision" htmlFor="subdivision">
                  <Select id="subdivision" label="Subdivision" value={String(cfg().subdivision)} options={SUBDIVISIONS} onChange={(v) => update({ subdivision: Number(v) })} />
                </Field>
              </div>
              <Field label={"Subdivision level " + subShown() + "%"} htmlFor="sub-level">
                <input
                  id="sub-level"
                  class="range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={String(subShown())}
                  onInput={(e: Event) => setSubShown(Number((e.target as HTMLInputElement).value))}
                  onChange={(e: Event) => update({ subLevel: Number((e.target as HTMLInputElement).value) / 100 })}
                />
              </Field>
              <Field label="Accents" hint="Click a beat to cycle accent, normal, soft and silent.">
                <div class="accent-row">
                  {cfg().accents.map((level, i) => (
                    <button
                      class="accent-button"
                      type="button"
                      key={i}
                      data-level={String(level)}
                      aria-label={"Beat " + (i + 1) + ": " + accentLabel(level)}
                      title={accentLabel(level)}
                      onClick={() => cycle(i)}
                    >
                      <span class="accent-bar" />
                      <span class="accent-index">{String(i + 1)}</span>
                    </button>
                  ))}
                </div>
              </Field>
            </PanelBody>
          </Panel>
        </div>

        <div class="stack">
          <Panel>
            <PanelHead title="Polyrhythm" />
            <PanelBody>
              <Field label={"Second rhythm: " + polyLabel(cfg().polyBeats, cfg().beatsPerBar)} htmlFor="poly" hint="Spreads this many extra clicks evenly across the bar, for example 3 over 4.">
                <Select id="poly" label="Polyrhythm" value={String(cfg().polyBeats)} options={POLYS} onChange={(v) => update({ polyBeats: Number(v) })} />
              </Field>
              <Field label={"Polyrhythm level " + polyShown() + "%"} htmlFor="poly-level">
                <input
                  id="poly-level"
                  class="range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={String(polyShown())}
                  onInput={(e: Event) => setPolyShown(Number((e.target as HTMLInputElement).value))}
                  onChange={(e: Event) => update({ polyLevel: Number((e.target as HTMLInputElement).value) / 100 })}
                />
              </Field>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Silent bars" />
            <PanelBody>
              <div class="field-row">
                <Field label="Play bars" htmlFor="play-bars">
                  <input
                    id="play-bars"
                    class="krate-input"
                    type="number"
                    min="1"
                    max="64"
                    step="1"
                    value={String(cfg().playBars)}
                    onChange={(e: Event) => update({ playBars: Number((e.target as HTMLInputElement).value) })}
                  />
                </Field>
                <Field label="Then silent bars" htmlFor="silent-bars">
                  <input
                    id="silent-bars"
                    class="krate-input"
                    type="number"
                    min="0"
                    max="64"
                    step="1"
                    value={String(cfg().silentBars)}
                    onChange={(e: Event) => update({ silentBars: Number((e.target as HTMLInputElement).value) })}
                  />
                </Field>
              </div>
              <p class="field-hint">
                {cfg().silentBars > 0
                  ? "The click plays for " + cfg().playBars + " bar" + (cfg().playBars === 1 ? "" : "s") + " and drops out for " + cfg().silentBars + ". The beat display keeps counting."
                  : "Set silent bars above zero to practise keeping time without the click."}
              </p>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Sound" />
            <PanelBody>
              <Field label="Built-in sound" htmlFor="sound" hint="Choosing a built-in sound replaces any custom samples.">
                <Select id="sound" label="Built-in sound" value={cfg().sound} options={SOUNDS} onChange={(v) => update({ sound: v })} />
              </Field>
              <div class="sound-list">
                {ROLES.map((r) => (
                  <div class="sound-row" key={r.role}>
                    <span class="sound-role">{r.label}</span>
                    <span class="sound-file mono" title={cfg().customSounds[r.role] || ""}>
                      {cfg().customSounds[r.role] ? baseName(cfg().customSounds[r.role]) : "Built-in"}
                    </span>
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => chooseSound(r.role)}>
                      Choose file
                    </button>
                    <button class="krate-button krate-button-ghost krate-button-sm" type="button" disabled={!cfg().customSounds[r.role]} onClick={() => resetSound(r.role)}>
                      Reset
                    </button>
                  </div>
                ))}
              </div>
              <div class="detail-actions">
                <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => chooseSound("all")}>
                  Use one file for every slot
                </button>
                <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => resetSound("all")}>
                  Reset all
                </button>
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </main>
  );
}
