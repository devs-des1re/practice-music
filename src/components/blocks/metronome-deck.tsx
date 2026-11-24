import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { openFile } from "@krate/app/dialog";
import { AudioStream, StartAudio } from "../../../api/audio.go";
import { Engine } from "../../../api/host.go";
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
} from "../../../api/session.go";
import { Field } from "../ui/field";
import { FoldButton } from "../ui/fold-button";
import { Select } from "../ui/select";
import { RunGlyph } from "../ui/glyphs";
import { Notice } from "../ui/notice";
import { LiveText } from "../ui/live-text";
import { SUBDIVISIONS, accentLabel, barCaption, cleanBpm, cycleAccent, polyLabel } from "../../lib/mixer";
import { isTyping } from "../../lib/workspace";
import { logger } from "../../lib/logger";
import type { AudioState, MetronomeSetup } from "../../lib/types";

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

const POLYS = [{ value: "0", label: "Off" }, ...Array.from({ length: 11 }, (_, i) => ({ value: String(i + 2), label: String(i + 2) }))];

const ROLES = [
  { role: "accent", label: "Accent" },
  { role: "beat", label: "Beat" },
  { role: "sub", label: "Subdivision" },
  { role: "poly", label: "Polyrhythm" },
];

const LARGE_KEY = "pm.metronome.large";

const AUDIO_PATTERNS = ["*.wav", "*.mp3", "*.flac", "*.ogg", "*.m4a", "*.opus"];

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function MetronomeDeck() {
  const [cfg, setCfg] = createSignal<MetronomeSetup>(emptyCfg);
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [shown, setShown] = createSignal({ beat: -1, bar: 0, level: 2, silent: false });
  const [error, setError] = createSignal("");
  const [bpmText, setBpmText] = createSignal("120");
  const [volumeShown, setVolumeShown] = createSignal(50);
  const [subShown, setSubShown] = createSignal(55);
  const [polyShown, setPolyShown] = createSignal(80);
  const [captionText, setCaptionText] = createSignal("Stopped");
  const [view, setView] = createSignal("play");
  const [large, setLarge] = createSignal(false);
  const [engineState, setEngineState] = createSignal("");

  createEffect(() => {
    const next = AudioStream();
    if (next) setAudio(next);
  });

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
    setBpmText(c.bpm.toFixed(c.bpm % 1 === 0 ? 0 : 1));
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
    setCaptionText(b.beat >= 0 ? (b.silent ? "Silent bar. " : "") + barCaption(b.bar, b.beat, cfg().beatsPerBar) : "Stopped");
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

  function toggleLarge() {
    const next = !large();
    setLarge(next);
    try {
      localStorage.setItem(LARGE_KEY, next ? "1" : "0");
    } catch {
      return;
    }
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
      if (res.found) setCfg({ ...cfg(), bpm: res.bpm });
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
      if (!files || files.length === 0) return;
      await ensureAudio();
      setCfg(await LoadMetronomeSound(role, files[0]));
    });
  }

  function resetSound(role: string) {
    guard(async () => {
      setCfg(await ClearMetronomeSound(role));
    });
  }

  onMount(() => {
    setLarge(localStorage.getItem(LARGE_KEY) === "1");
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === "m" || e.key === "M") {
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
    <section class="panel ws-panel metro-panel" data-panel="metronome" data-size={large() ? "large" : "standard"} aria-label="Metronome">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:metronome" />
          Metronome
        </h2>
        <div class="metro-mini">
          <button class="tp-btn mini-run" type="button" aria-label="Start or stop the click" data-tip="Start or stop the click" data-keys="M" data-on={audio().metronome.running ? "true" : "false"} onClick={toggleRun}>
            <RunGlyph on={audio().metronome.running} />
          </button>
          <LiveText class="mini-bpm mono" text={bpmText() + " BPM"} />
          <div class="mini-leds" aria-hidden="true">
            {cfg().accents.map((level, i) => (
              <span class="mini-led" key={i} data-level={String(level)} data-on={shown().beat === i ? "true" : "false"} />
            ))}
          </div>
        </div>
        <div class="panel-tools">
          <div class="segmented metro-tabs">
            <button class="segment" type="button" data-active={view() === "play" ? "true" : "false"} onClick={() => setView("play")}>
              Click
            </button>
            <button class="segment" type="button" data-active={view() === "setup" ? "true" : "false"} onClick={() => setView("setup")}>
              Setup
            </button>
          </div>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm size-button" type="button" aria-label="Large display" data-tip="Large display for playing along" data-on={large() ? "true" : "false"} onClick={toggleLarge}>
            <Icon name="lucide:maximize-2" />
          </button>
          <FoldButton />
        </div>
      </header>

      <div class="panel-notices" showIf={!!error()}>
        <div>
          <Notice tone="bad" text={error()} />
        </div>
      </div>

      <div class="metro-body" showIf={view() === "play"}>
        <div class="metro-top">
          <label class="bpm-lcd" data-tip="Tempo. Up and Down keys nudge it.">
            <input
              class="bpm-input"
              type="number"
              step="0.1"
              aria-label="Tempo in beats per minute"
              value={bpmText()}
              onInput={(e: Event) => setBpmText((e.target as HTMLInputElement).value)}
              onChange={(e: Event) => setTempo(Number((e.target as HTMLInputElement).value))}
            />
            <span class="bpm-unit">BPM</span>
          </label>
          <div class="bpm-steps">
            <button class="tp-btn" type="button" aria-label="Faster" data-tip="Faster by 1, Shift for 5" data-keys="Up" onClick={(e: MouseEvent) => nudge(e.shiftKey ? 5 : 1)}>
              <Icon name="lucide:plus" />
            </button>
            <button class="tp-btn" type="button" aria-label="Slower" data-tip="Slower by 1, Shift for 5" data-keys="Down" onClick={(e: MouseEvent) => nudge(e.shiftKey ? -5 : -1)}>
              <Icon name="lucide:minus" />
            </button>
          </div>
        </div>

        <div class="beat-leds" aria-label="Beat indicator">
          {cfg().accents.map((level, i) => (
            <div class="beat-led" key={i} data-level={String(level)} data-on={shown().beat === i ? "true" : "false"} data-silent={shown().silent ? "true" : "false"}>
              {String(i + 1)}
            </div>
          ))}
        </div>
        <LiveText class="metro-caption" text={captionText()} />

        <div class="metro-actions">
          <button class="krate-button krate-button-primary" type="button" data-tip="Start or stop the click" data-keys="M" onClick={toggleRun}>
            <RunGlyph on={audio().metronome.running} offLabel="Start" onLabel="Stop" />
          </button>
          <button class="krate-button krate-button-secondary" type="button" data-tip="Tap the tempo" data-keys="T" onClick={tap}>
            <Icon name="lucide:hand" />
            Tap
          </button>
        </div>

        <div class="metro-extra">
          <section class="metro-group">
            <h3 class="section-title">Time</h3>
            <div class="metro-fields">
              <div class="field">
                <label class="field-label" for="beats">
                  Beats per bar
                </label>
                <Select id="beats" label="Beats per bar" value={String(cfg().beatsPerBar)} options={BEATS} onChange={(v) => update({ beatsPerBar: Number(v) })} />
              </div>
              <div class="field">
                <label class="field-label" for="subdivision">
                  Subdivision
                </label>
                <Select id="subdivision" label="Subdivision" value={String(cfg().subdivision)} options={SUBDIVISIONS} onChange={(v) => update({ subdivision: Number(v) })} />
              </div>
            </div>
          </section>

          <section class="metro-group">
            <h3 class="section-title">Accents</h3>
            <div class="accent-row">
              {cfg().accents.map((level, i) => (
                <button class="accent-button" type="button" key={i} data-level={String(level)} aria-label={"Beat " + (i + 1) + ": " + accentLabel(level)} data-tip={accentLabel(level) + ". Click to change."} onClick={() => cycle(i)}>
                  <span class="accent-bar" />
                  <span class="accent-index">{String(i + 1)}</span>
                </button>
              ))}
            </div>
          </section>

          <div class="param param-wide">
            <span class="param-label">Volume</span>
            <input
              class="range"
              type="range"
              min="0"
              max="100"
              step="1"
              aria-label="Metronome volume"
              data-tip="Click volume"
              value={String(volumeShown())}
              onInput={(e: Event) => setVolumeShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => update({ volume: Number((e.target as HTMLInputElement).value) / 100 })}
            />
            <LiveText class="param-value" text={volumeShown() + "%"} />
          </div>
        </div>
      </div>

      <div class="metro-setup" showIf={view() === "setup"}>
        <div class="setup-block">
          <span class="setup-title">Bar</span>
          <div class="field-row compact">
            <Field label="Beats" htmlFor="beats">
              <Select id="beats" label="Beats per bar" value={String(cfg().beatsPerBar)} options={BEATS} onChange={(v) => update({ beatsPerBar: Number(v) })} />
            </Field>
            <Field label="Subdivision" htmlFor="subdivision">
              <Select id="subdivision" label="Subdivision" value={String(cfg().subdivision)} options={SUBDIVISIONS} onChange={(v) => update({ subdivision: Number(v) })} />
            </Field>
          </div>
          <div class="ctrl-line">
            <span class="ctrl-label">Sub level</span>
            <input
              class="range"
              type="range"
              min="0"
              max="100"
              step="1"
              aria-label="Subdivision level"
              value={String(subShown())}
              onInput={(e: Event) => setSubShown(Number((e.target as HTMLInputElement).value))}
              onChange={(e: Event) => update({ subLevel: Number((e.target as HTMLInputElement).value) / 100 })}
            />
            <LiveText class="ctrl-value" text={subShown() + "%"} />
          </div>
          <div class="accent-row">
            {cfg().accents.map((level, i) => (
              <button class="accent-button" type="button" key={i} data-level={String(level)} aria-label={"Beat " + (i + 1) + ": " + accentLabel(level)} title={accentLabel(level)} onClick={() => cycle(i)}>
                <span class="accent-bar" />
                <span class="accent-index">{String(i + 1)}</span>
              </button>
            ))}
          </div>
        </div>

        <div class="setup-block">
          <span class="setup-title">Polyrhythm</span>
          <div class="field-row compact">
            <Field label={polyLabel(cfg().polyBeats, cfg().beatsPerBar)} htmlFor="poly">
              <Select id="poly" label="Polyrhythm" value={String(cfg().polyBeats)} options={POLYS} onChange={(v) => update({ polyBeats: Number(v) })} />
            </Field>
            <Field label={"Level " + polyShown() + "%"} htmlFor="poly-level">
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
          </div>
        </div>

        <div class="setup-block">
          <span class="setup-title">Silent bars</span>
          <div class="field-row compact">
            <Field label="Play bars" htmlFor="play-bars">
              <input id="play-bars" class="krate-input" type="number" min="1" max="64" step="1" value={String(cfg().playBars)} onChange={(e: Event) => update({ playBars: Number((e.target as HTMLInputElement).value) })} />
            </Field>
            <Field label="Then silent" htmlFor="silent-bars">
              <input id="silent-bars" class="krate-input" type="number" min="0" max="64" step="1" value={String(cfg().silentBars)} onChange={(e: Event) => update({ silentBars: Number((e.target as HTMLInputElement).value) })} />
            </Field>
          </div>
        </div>

        <div class="setup-block">
          <span class="setup-title">Sound</span>
          <Select id="sound" label="Built-in sound" value={cfg().sound} options={SOUNDS} onChange={(v) => update({ sound: v })} />
          <div class="sound-list">
            {ROLES.map((r) => (
              <div class="sound-row" key={r.role}>
                <span class="sound-role">{r.label}</span>
                <span class="sound-file mono" title={cfg().customSounds[r.role] || ""}>
                  {cfg().customSounds[r.role] ? baseName(cfg().customSounds[r.role]) : "Built-in"}
                </span>
                <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Choose a file for " + r.label} data-tip="Choose a file" onClick={() => chooseSound(r.role)}>
                  <Icon name="lucide:folder-open" />
                </button>
                <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Reset " + r.label} data-tip="Back to built-in" disabled={!cfg().customSounds[r.role]} onClick={() => resetSound(r.role)}>
                  <Icon name="lucide:rotate-ccw" />
                </button>
              </div>
            ))}
          </div>
          <div class="detail-actions">
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => chooseSound("all")}>
              One file for all
            </button>
            <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => resetSound("all")}>
              Reset all
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
