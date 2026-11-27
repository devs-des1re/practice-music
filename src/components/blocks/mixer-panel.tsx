import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { AudioStream } from "../../../api/audio.go";
import {
  GetMixer,
  SetMixerStrip,
  SetMixerMaster,
  ResetMixer,
  ResetMeters,
  SessionEpoch,
  ActiveScene,
} from "../../../api/session.go";
import { PlayerStream } from "../../../api/player.go";
import { Scenes, SaveScene, RecallScene, RenameScene, DeleteScene, SceneRevision } from "../../../api/scenes.go";
import { GainReduction, Meter, PeakReadout } from "./meter";
import { Fader } from "../ui/fader";
import { Field } from "../ui/field";
import { ParamRow } from "../ui/param-row";
import { Section } from "../ui/section";
import { Select } from "../ui/select";
import { FoldButton } from "../ui/fold-button";
import { Notice } from "../ui/notice";
import { LiveText } from "../ui/live-text";
import { Menu, type MenuItem } from "../ui/menu";
import { askConfirm, askText } from "../../lib/modal";
import { DIVIDER, openContextMenu } from "../../lib/context-menu";
import { channelPairs, formatDb, inDisplayOrder, isListening, listenSend, sourceOptions } from "../../lib/mixer";
import { formatClock } from "../../lib/waveform";
import { handleError, onRefresh, logFailure } from "../../lib/service";
import { subscribePrefs } from "../../lib/prefs";
import type { AudioState, MixerBoard, MixerMaster, MixerStrip, SceneInfo, SceneStatus } from "../../lib/types";

const emptyMaster: MixerMaster = {
  main: 0,
  monitor: 0,
  limiter: true,
  ceiling: -0.3,
  mainChannel: 0,
  monitorChannel: 0,
};

const emptyBoard: MixerBoard = { strips: [], master: emptyMaster };

const emptyAudio = {
  running: false,
  device: "",
  channels: 0,
  sampleRate: 0,
  periodMs: 0,
  streamLatencyMs: 0,
  mode: "",
  error: "",
  capture: null,
  monitor: null,
} as unknown as AudioState;

const noLink = { mode: "", running: false, device: "", channels: 0, sampleRate: 0, rateMismatch: false, error: "" };

const noStrip = {
  index: 0,
  kind: "song",
  name: "",
  gain: 0,
  pan: 0,
  main: 0,
  monitor: 0,
  mute: false,
  solo: false,
  source: 0,
  stereo: false,
  eq: { low: 0, mid: 0, high: 0 },
  comp: { on: false, threshold: 0, ratio: 1, attack: 10, release: 100, makeup: 0 },
} as unknown as MixerStrip;

const FADER_MARKS = [12, 0, -12, -24, -36, -48, -60];
const INSPECTOR_KEY = "pm.mixer.inspector";
const INSPECTOR_OPEN_KEY = "pm.mixer.inspector.open";
const SECTIONS_KEY = "pm.inspector.sections";
const INSPECTOR_DEFAULT = 288;
const INSPECTOR_MIN = 232;
const INSPECTOR_MAX = 520;

function toneOf(s: MixerStrip): string {
  if (s.kind === "song") return "1";
  if (s.kind === "click") return "2";
  if (s.kind === "drums") return "7";
  return String(3 + (s.index % 4));
}

function sourceText(s: MixerStrip): string {
  if (s.kind === "song") return "Song player";
  if (s.kind === "click") return "Metronome";
  if (s.kind === "drums") return "MIDI kit";
  return s.stereo ? "In " + (s.source + 1) + "-" + (s.source + 2) : "In " + (s.source + 1);
}

function panText(pan: number): string {
  if (Math.abs(pan) < 0.02) return "C";
  return (pan < 0 ? "L" : "R") + Math.round(Math.abs(pan) * 100);
}

function latencyText(audio: AudioState): string {
  if (!audio.running) return "audio stopped";
  const out = audio.streamLatencyMs > 0 ? audio.streamLatencyMs : audio.periodMs;
  return out > 0 ? out.toFixed(1) + " ms" : "not reported";
}

export function MixerPanel() {
  const [board, setBoard] = createSignal<MixerBoard>(emptyBoard);
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [scenes, setScenes] = createSignal<SceneInfo[]>([]);
  const [active, setActive] = createSignal<SceneStatus>({ id: 0, name: "", modified: false });
  const [sceneMenu, setSceneMenu] = createSignal(false);
  const [sceneMenuX, setSceneMenuX] = createSignal(0);
  const [sceneMenuY, setSceneMenuY] = createSignal(0);
  const [sceneItems, setSceneItems] = createSignal<MenuItem[]>([]);
  const [latOut, setLatOut] = createSignal("audio stopped");
  const [latMode, setLatMode] = createSignal("-");
  const [latInputs, setLatInputs] = createSignal("no input device chosen");
  const [latMonitor, setLatMonitor] = createSignal("on the main output");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [tab, setTab] = createSignal("channel");
  const [inspectorTitle, setInspectorTitle] = createSignal("Channel");
  const [faderStep, setFaderStep] = createSignal(0.5);
  const [songRows, setSongRows] = createSignal<string[]>(["No song loaded", "-", "-", "-", "-", "-", "-"]);
  const [inspect, setInspect] = createSignal(false);
  const [ceilingText, setCeilingText] = createSignal("-0.3 dB");
  const [inspectorWidth, setInspectorWidth] = createSignal(INSPECTOR_DEFAULT);
  const [closedSections, setClosedSections] = createSignal<Record<string, boolean>>({});
  onMount(() => onCleanup(subscribePrefs((p) => setFaderStep(p.faderStepDb))));
  const strip = () => board().strips[selected()] || noStrip;
  const cap = () => audio().capture ?? noLink;
  const mon = () => audio().monitor ?? noLink;
  const sending: Record<string, boolean> = {};
  const dirty: Record<string, boolean> = {};
  const heardAt: Record<number, number> = {};

  createEffect(() => {
    const next = AudioStream();
    if (next) setAudio(next);
  });

  createEffect(() => {
    const p = PlayerStream();
    if (!p || !p.loaded) {
      setSongRows(["No song loaded", "-", "-", "-", "-", "-", "-"]);
      return;
    }
    const grid = p.grid;
    const tempo = grid && grid.bpm > 0 ? grid.bpm.toFixed(1) + " BPM" : "Not detected";
    const meter = grid && grid.bpm > 0 ? grid.beatsPerBar + " beats per bar" : "-";
    const pitch = (p.pitch > 0 ? "+" : "") + p.pitch.toFixed(1) + " st";
    const loop = p.loop.enabled ? formatClock(p.loop.startMs) + " to " + formatClock(p.loop.endMs) : "Off";
    setSongRows([
      p.title || "Untitled",
      p.artist || "-",
      formatClock(p.durationMs),
      tempo,
      meter,
      Math.round(p.speed * 100) + "% speed, " + pitch,
      loop,
    ]);
  });

  createEffect(() => {
    const next = ActiveScene();
    if (next) setActive(next);
  });

  createEffect(() => {
    const a = audio();
    const c = a.capture ?? noLink;
    const m = a.monitor ?? noLink;
    setLatOut(latencyText(a));
    setLatMode(a.running ? a.mode + " at " + a.sampleRate + " Hz" : "-");
    setLatInputs(c.running ? c.device + ", " + c.channels + " channels" : c.error ? c.error : "no input device chosen");
    setLatMonitor(m.mode === "device" && m.running ? m.device : "on the main output");
  });

  createEffect(() => {
    setInspectorTitle(strip().name || "Channel");
  });

  createEffect(() => {
    setCeilingText(board().master.ceiling.toFixed(1) + " dB");
  });

  onMount(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_KEY));
    if (saved >= INSPECTOR_MIN && saved <= INSPECTOR_MAX) setInspectorWidth(saved);
    try {
      const raw = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}");
      if (raw && typeof raw === "object") setClosedSections(raw);
    } catch {
      setClosedSections({});
    }
    const remembered = localStorage.getItem(INSPECTOR_OPEN_KEY);
    const box = document.getElementById("console");
    if (remembered === "1" || remembered === "0") setInspect(remembered === "1");
    else if (box && box.clientWidth >= 73.75 * parseFloat(getComputedStyle(document.documentElement).fontSize))
      setInspect(true);
    const off = onRefresh(() => {
      GetMixer()
        .then((next) => setBoard(next))
        .catch((e) => handleError(e, setError));
      Scenes()
        .then((list) => setScenes(list))
        .catch((e) => handleError(e, setError));
    });
    onCleanup(off);
  });

  createEffect(() => {
    const width = inspectorWidth();
    if (typeof document === "undefined") return;
    const el = document.getElementById("console");
    if (el) el.style.setProperty("--inspector-width", width + "px");
  });

  function isOpen(key: string): boolean {
    return !closedSections()[key];
  }

  function toggleSection(key: string) {
    const next = { ...closedSections(), [key]: !closedSections()[key] };
    setClosedSections(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {
      return;
    }
  }

  function showInspector(open: boolean) {
    setInspect(open);
    try {
      localStorage.setItem(INSPECTOR_OPEN_KEY, open ? "1" : "0");
    } catch {
      return;
    }
  }

  function startInspectorResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = document.getElementById("console");
    if (!box) return;
    const right = box.getBoundingClientRect().right;
    const move = (ev: PointerEvent) => {
      setInspectorWidth(Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, right - ev.clientX))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(INSPECTOR_KEY, String(inspectorWidth()));
      } catch {
        return;
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  createEffect(() => {
    SessionEpoch();
    GetMixer()
      .then((next) => setBoard(next))
      .catch((e) => logFailure("mixer state failed", e));
  });

  createEffect(() => {
    SceneRevision();
    Scenes()
      .then((list) => setScenes(list))
      .catch((e) => logFailure("scene list failed", e));
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logFailure("mixer action failed", e);
      handleError(e, setError);
    }
  }

  async function flush(key: string, send: () => Promise<unknown>) {
    if (sending[key]) {
      dirty[key] = true;
      return;
    }
    sending[key] = true;
    try {
      do {
        dirty[key] = false;
        await send();
      } while (dirty[key]);
    } catch (e) {
      logFailure("mixer update failed", e);
      handleError(e, setError);
    } finally {
      sending[key] = false;
    }
  }

  function patchStrip(index: number, change: (s: MixerStrip) => MixerStrip) {
    const strips = board().strips.slice();
    strips[index] = change(strips[index]);
    setBoard({ ...board(), strips });
    flush("strip" + index, () => SetMixerStrip(index, board().strips[index]));
  }

  function patchMaster(change: (m: MixerMaster) => MixerMaster) {
    setBoard({ ...board(), master: change(board().master) });
    flush("master", () => SetMixerMaster(board().master));
  }

  function toggleListen(index: number) {
    const current = board().strips[index];
    if (!current) return;
    const next = listenSend(current.main, heardAt[index]);
    if (isListening(current.main)) heardAt[index] = current.main;
    patchStrip(index, (x) => ({ ...x, main: next }));
  }

  function stripMenu(e: MouseEvent, index: number) {
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
    const strip = board().strips[index];
    if (!strip) return;
    setSelected(index);
    openContextMenu(e, [
      { label: isListening(strip.main) ? "Stop listening" : "Listen", onSelect: () => toggleListen(index) },
      { label: strip.mute ? "Unmute" : "Mute", onSelect: () => patchStrip(index, (x) => ({ ...x, mute: !x.mute })) },
      { label: strip.solo ? "Solo off" : "Solo", onSelect: () => patchStrip(index, (x) => ({ ...x, solo: !x.solo })) },
      DIVIDER,
      {
        label: "Set level to 0 dB",
        disabled: strip.gain === 0,
        onSelect: () => patchStrip(index, (x) => ({ ...x, gain: 0 })),
      },
      {
        label: "Centre the pan",
        disabled: strip.pan === 0,
        onSelect: () => patchStrip(index, (x) => ({ ...x, pan: 0 })),
      },
      DIVIDER,
      {
        label: "Channel settings",
        onSelect: () => {
          setTab("channel");
          showInspector(true);
        },
      },
      { label: "Rename channel", disabled: strip.kind !== "input", onSelect: () => void renameChannel(index) },
    ]);
  }

  function numberOf(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  function recall(id: number) {
    guard(async () => {
      const scene = await RecallScene(id);
      setInfo("Scene " + scene.name + " recalled.");
    });
  }

  async function saveAs() {
    const name = await askText({
      title: "Save scene",
      label: "Scene name",
      confirmLabel: "Save scene",
      placeholder: "Rehearsal mix",
      maxLength: 40,
    });
    if (!name) return;
    if (scenes().some((sc) => sc.name.toLowerCase() === name.toLowerCase())) {
      const replace = await askConfirm({
        title: "Replace scene",
        message: "A scene called " + name + " already exists. Replace it with the current mix?",
        confirmLabel: "Replace",
        danger: true,
      });
      if (!replace) return;
    }
    guard(async () => {
      const scene = await SaveScene(name);
      setInfo("Scene " + scene.name + " saved.");
    });
  }

  async function updateActive() {
    const name = active().name;
    if (!name) return;
    const yes = await askConfirm({
      title: "Update scene",
      message: "Overwrite the scene " + name + " with the current mix?",
      confirmLabel: "Update",
    });
    if (!yes) return;
    guard(async () => {
      const scene = await SaveScene(name);
      setInfo("Scene " + scene.name + " updated.");
    });
  }

  async function renameActive() {
    const current = active();
    if (current.id === 0) return;
    const name = await askText({
      title: "Rename scene",
      label: "Scene name",
      confirmLabel: "Rename",
      value: current.name,
      maxLength: 40,
    });
    if (!name || name === current.name) return;
    guard(async () => {
      await RenameScene(current.id, name);
      setInfo("Scene renamed to " + name + ".");
    });
  }

  async function removeActive() {
    const current = active();
    if (current.id === 0) return;
    const yes = await askConfirm({
      title: "Delete scene",
      message: "Delete the scene " + current.name + "? This cannot be undone.",
      confirmLabel: "Delete scene",
      danger: true,
    });
    if (!yes) return;
    guard(async () => {
      await DeleteScene(current.id);
      setInfo("Scene deleted.");
    });
  }

  async function resetAll() {
    const yes = await askConfirm({
      title: "Reset mixer",
      message: "Put every fader, send, EQ and compressor back to its default?",
      confirmLabel: "Reset mixer",
      danger: true,
    });
    if (!yes) return;
    guard(async () => {
      await ResetMixer();
      setInfo("Mixer reset.");
    });
  }

  async function renameChannel(index: number) {
    const current = board().strips[index];
    if (!current) return;
    const name = await askText({
      title: "Rename channel",
      label: "Channel name",
      confirmLabel: "Rename",
      value: current.name,
      maxLength: 24,
    });
    if (name) patchStrip(index, (x) => ({ ...x, name }));
  }

  function openSceneMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const none = active().id === 0;
    setSceneItems([
      { label: "Save as new scene", onSelect: () => saveAs() },
      { label: "Update current scene", disabled: none || !active().modified, onSelect: () => updateActive() },
      { label: "Rename current scene", disabled: none, onSelect: () => renameActive() },
      { label: "", separator: true },
      { label: "Delete current scene", tone: "danger", disabled: none, onSelect: () => removeActive() },
    ]);
    setSceneMenuX(r.left);
    setSceneMenuY(r.bottom + 2);
    setSceneMenu(!sceneMenu());
  }

  return (
    <section class="panel ws-panel mixer-panel" data-panel="mixer" aria-label="Mixer">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:sliders-vertical" />
          Mixer
        </h2>
        <div class="panel-tools">
          <Select
            id="scene-recall"
            label="Recall a scene"
            value={String(active().id)}
            options={[{ value: "0", label: scenes().length === 0 ? "No scenes yet" : "Recall a scene" }].concat(
              scenes().map((sc) => ({ value: String(sc.id), label: sc.name })),
            )}
            onChange={(v) => {
              if (Number(v)) recall(Number(v));
            }}
          />
          <button
            class="krate-button krate-button-secondary krate-button-sm"
            type="button"
            aria-haspopup="menu"
            data-tip="Save, rename or delete scenes"
            onClick={openSceneMenu}
          >
            <Icon name="lucide:bookmark" />
            Scenes
            <Icon name="lucide:chevron-down" />
          </button>
          <span class="tool-divider" />
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Clear clip lights"
            data-tip="Clear clip lights and peaks"
            onClick={() => guard(() => ResetMeters())}
          >
            <Icon name="lucide:eraser" />
          </button>
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Reset the mixer"
            data-tip="Reset every channel"
            onClick={resetAll}
          >
            <Icon name="lucide:rotate-ccw" />
          </button>
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Channel settings"
            data-tip="Show or hide the inspector"
            data-on={inspect() ? "true" : "false"}
            onClick={() => showInspector(!inspect())}
          >
            <Icon name="lucide:panel-right" />
          </button>
          <FoldButton />
        </div>
      </header>

      <div class="panel-notices" showIf={!!error() || !!info()}>
        <div showIf={!!error()}>
          <Notice tone="bad" text={error()} />
        </div>
        <div showIf={!!info() && !error()}>
          <Notice tone="ok" text={info()} />
        </div>
      </div>

      <div class="console" id="console" data-inspect={inspect() ? "true" : "false"}>
        <div class="channels">
          <div class="loading-state" data-on={board().strips.length === 0 ? "true" : "false"}>
            <Icon name="lucide:loader" />
            Waiting for the audio engine
          </div>
          {inDisplayOrder(board().strips).map((s) => (
            <section
              class="strip"
              key={s.index}
              data-tone={toneOf(s)}
              data-selected={selected() === s.index ? "true" : "false"}
              data-muted={s.mute ? "true" : "false"}
              aria-label={s.name + " channel"}
              onClick={() => setSelected(s.index)}
              onContextMenu={(e: MouseEvent) => stripMenu(e, s.index)}
            >
              <div class="strip-body">
                <div class="strip-head">
                  <span class="strip-source">{sourceText(s)}</span>
                  <button
                    class="strip-edit"
                    type="button"
                    data-on={selected() === s.index && inspect() ? "true" : "false"}
                    aria-label={"EQ and routing for " + s.name}
                    data-tip="EQ, compressor and routing"
                    onClick={() => {
                      setSelected(s.index);
                      setTab("channel");
                      showInspector(true);
                    }}
                  >
                    <Icon name="lucide:sliders-horizontal" />
                  </button>
                </div>

                <label class="strip-pan" data-tip="Pan. Double-click to centre.">
                  <span class="strip-label">{panText(s.pan)}</span>
                  <input
                    class="range"
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    aria-label={s.name + " pan"}
                    value={String(s.pan)}
                    onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, pan: numberOf(e) }))}
                    onDoubleClick={() => patchStrip(s.index, (x) => ({ ...x, pan: 0 }))}
                  />
                </label>

                <div class="strip-readouts">
                  <div class="strip-db mono" data-tip="Fader level in dB">
                    {formatDb(s.gain)}
                  </div>
                  <PeakReadout which={String(s.index)} />
                </div>

                <div class="strip-main">
                  <Fader
                    label={s.name + " level"}
                    value={s.gain}
                    min={-60}
                    max={12}
                    step={faderStep()}
                    marks={FADER_MARKS}
                    onInput={(v) => patchStrip(s.index, (x) => ({ ...x, gain: v }))}
                    onReset={() => patchStrip(s.index, (x) => ({ ...x, gain: 0 }))}
                  />
                  <Meter which={String(s.index)} label={s.name} />
                </div>

                <div class="strip-controls">
                  <button
                    class="strip-toggle strip-listen"
                    type="button"
                    data-kind="listen"
                    data-on={s.main > -60 ? "true" : "false"}
                    aria-pressed={s.main > -60}
                    aria-label={"Send " + s.name + " to the speakers"}
                    data-tip="Send this channel to your speakers with the music"
                    onClick={() => toggleListen(s.index)}
                  >
                    <Icon name="lucide:volume-2" />
                    Listen
                  </button>
                  <div class="strip-buttons">
                    <button
                      class="strip-toggle"
                      type="button"
                      data-on={s.mute ? "true" : "false"}
                      data-kind="mute"
                      aria-pressed={s.mute}
                      aria-label={"Mute " + s.name}
                      data-tip="Mute"
                      onClick={() => patchStrip(s.index, (x) => ({ ...x, mute: !x.mute }))}
                    >
                      M
                    </button>
                    <button
                      class="strip-toggle"
                      type="button"
                      data-on={s.solo ? "true" : "false"}
                      data-kind="solo"
                      aria-pressed={s.solo}
                      aria-label={"Solo " + s.name}
                      data-tip="Solo"
                      onClick={() => patchStrip(s.index, (x) => ({ ...x, solo: !x.solo }))}
                    >
                      S
                    </button>
                  </div>
                  <label class="strip-send" data-tip="Send to the headphone monitor mix. Double-click to reset.">
                    <span class="strip-label">Mon</span>
                    <input
                      class="range"
                      type="range"
                      min="-60"
                      max="12"
                      step="0.5"
                      aria-label={s.name + " monitor send"}
                      value={String(s.monitor)}
                      onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, monitor: numberOf(e) }))}
                      onDoubleClick={() => patchStrip(s.index, (x) => ({ ...x, monitor: 0 }))}
                    />
                  </label>
                </div>
              </div>

              <div class="strip-foot">
                {s.kind === "input" ? (
                  <button
                    class="strip-name strip-rename"
                    type="button"
                    aria-label={"Rename " + s.name}
                    data-tip="Rename channel"
                    onClick={() => renameChannel(s.index)}
                  >
                    {s.name}
                  </button>
                ) : (
                  <span class="strip-name">{s.name}</span>
                )}
              </div>
            </section>
          ))}
        </div>

        <aside class="strip master" aria-label="Master section">
          <div class="strip-body">
            <div class="strip-head">
              <span class="strip-source">Stereo output</span>
              <button
                class="strip-edit"
                type="button"
                data-on={inspect() && tab() === "routing" ? "true" : "false"}
                aria-label="Outputs, limiter and latency"
                data-tip="Outputs, limiter and latency"
                onClick={() => {
                  setTab("routing");
                  showInspector(true);
                }}
              >
                <Icon name="lucide:route" />
              </button>
            </div>
            <div class="master-buses">
              <div class="master-bus">
                <span class="strip-label bus-label">Main</span>
                <div class="strip-readouts">
                  <div class="strip-db mono" data-tip="Main level in dB">
                    {formatDb(board().master.main)}
                  </div>
                  <PeakReadout which="main" />
                </div>
                <div class="strip-main">
                  <Fader
                    label="Main mix level"
                    value={board().master.main}
                    min={-60}
                    max={12}
                    step={faderStep()}
                    marks={FADER_MARKS}
                    onInput={(v) => patchMaster((m) => ({ ...m, main: v }))}
                    onReset={() => patchMaster((m) => ({ ...m, main: 0 }))}
                  />
                  <Meter which="main" label="Main mix" />
                </div>
              </div>
              <div class="master-bus">
                <span class="strip-label bus-label">Monitor</span>
                <div class="strip-readouts">
                  <div class="strip-db mono" data-tip="Monitor level in dB">
                    {formatDb(board().master.monitor)}
                  </div>
                  <PeakReadout which="monitor" />
                </div>
                <div class="strip-main">
                  <Fader
                    label="Monitor mix level"
                    value={board().master.monitor}
                    min={-60}
                    max={12}
                    step={faderStep()}
                    marks={FADER_MARKS}
                    onInput={(v) => patchMaster((m) => ({ ...m, monitor: v }))}
                    onReset={() => patchMaster((m) => ({ ...m, monitor: 0 }))}
                  />
                  <Meter which="monitor" label="Monitor mix" />
                </div>
              </div>
            </div>
            <div class="strip-controls">
              <button
                class="krate-button krate-button-secondary limiter-button"
                type="button"
                data-on={board().master.limiter ? "true" : "false"}
                aria-pressed={board().master.limiter}
                data-tip="Master limiter. The ceiling is set under Routing."
                onClick={() => patchMaster((m) => ({ ...m, limiter: !m.limiter }))}
              >
                <span class="led" data-on={board().master.limiter ? "true" : "false"} />
                Limiter
                <LiveText class="limiter-ceiling mono" text={ceilingText()} />
              </button>
              <GainReduction />
            </div>
          </div>
          <div class="strip-foot">
            <span class="strip-name">Master</span>
          </div>
        </aside>

        <aside class="mixer-inspector" aria-label="Channel settings">
          <div
            class="inspector-grip"
            role="separator"
            aria-label="Drag to resize the inspector"
            data-tip="Drag to resize"
            onPointerDown={startInspectorResize}
          />
          <header class="inspector-head">
            <LiveText class="inspector-title" text={tab() === "song" ? "Song" : inspectorTitle()} />
            <div class="segmented">
              <button
                class="segment"
                type="button"
                data-active={tab() === "song" ? "true" : "false"}
                onClick={() => setTab("song")}
              >
                Song
              </button>
              <button
                class="segment"
                type="button"
                data-active={tab() === "channel" ? "true" : "false"}
                onClick={() => setTab("channel")}
              >
                Channel
              </button>
              <button
                class="segment"
                type="button"
                data-active={tab() === "routing" ? "true" : "false"}
                onClick={() => setTab("routing")}
              >
                Routing
              </button>
            </div>
            <button
              class="krate-button krate-button-ghost krate-button-icon krate-button-sm inspector-close"
              type="button"
              aria-label="Close channel settings"
              onClick={() => showInspector(false)}
            >
              <Icon name="lucide:x" />
            </button>
          </header>

          <div class="inspector-body" showIf={tab() === "song"}>
            <Section title="Loaded song" open={isOpen("song")} onToggle={() => toggleSection("song")}>
              <div class="info-row">
                <span class="info-label">Title</span>
                <LiveText class="info-value" text={songRows()[0]} />
              </div>
              <div class="info-row">
                <span class="info-label">Artist</span>
                <LiveText class="info-value" text={songRows()[1]} />
              </div>
              <div class="info-row">
                <span class="info-label">Length</span>
                <LiveText class="info-value mono" text={songRows()[2]} />
              </div>
            </Section>
            <Section title="Practice" open={isOpen("practice")} onToggle={() => toggleSection("practice")}>
              <div class="info-row">
                <span class="info-label">Tempo</span>
                <LiveText class="info-value mono" text={songRows()[3]} />
              </div>
              <div class="info-row">
                <span class="info-label">Meter</span>
                <LiveText class="info-value mono" text={songRows()[4]} />
              </div>
              <div class="info-row">
                <span class="info-label">Playback</span>
                <LiveText class="info-value mono" text={songRows()[5]} />
              </div>
              <div class="info-row">
                <span class="info-label">Loop</span>
                <LiveText class="info-value mono" text={songRows()[6]} />
              </div>
            </Section>
          </div>

          <div class="inspector-body" showIf={tab() === "channel"}>
            <div showIf={strip().kind === "input"}>
              <Section title="Input" open={isOpen("input")} onToggle={() => toggleSection("input")}>
                <Select
                  id="strip-source"
                  label="Input source"
                  value={String(strip().source)}
                  options={sourceOptions(cap().channels, strip().stereo)}
                  onChange={(v) => patchStrip(selected(), (x) => ({ ...x, source: Number(v) }))}
                />
                <label class="check-row">
                  <input
                    type="checkbox"
                    checked={strip().stereo}
                    onChange={(e: Event) =>
                      patchStrip(selected(), (x) => ({ ...x, stereo: (e.target as HTMLInputElement).checked }))
                    }
                  />
                  Stereo pair
                </label>
              </Section>
            </div>

            <Section title="Levels" open={isOpen("levels")} onToggle={() => toggleSection("levels")}>
              <ParamRow
                label="Pan"
                ariaLabel="Pan"
                min={-1}
                max={1}
                step={0.01}
                value={strip().pan}
                text={panText(strip().pan)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, pan: v }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, pan: 0 }))}
              />
              <ParamRow
                label="Main"
                ariaLabel="Send to main"
                min={-60}
                max={12}
                step={0.5}
                value={strip().main}
                text={formatDb(strip().main)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, main: v }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, main: 0 }))}
              />
              <ParamRow
                label="Monitor"
                ariaLabel="Send to monitor"
                min={-60}
                max={12}
                step={0.5}
                value={strip().monitor}
                text={formatDb(strip().monitor)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, monitor: v }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, monitor: 0 }))}
              />
            </Section>

            <Section title="Equaliser" open={isOpen("eq")} onToggle={() => toggleSection("eq")}>
              <ParamRow
                label="Low"
                ariaLabel="Low shelf"
                min={-15}
                max={15}
                step={0.5}
                value={strip().eq.low}
                text={strip().eq.low.toFixed(1)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, low: v } }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, low: 0 } }))}
              />
              <ParamRow
                label="Mid"
                ariaLabel="Mid band"
                min={-15}
                max={15}
                step={0.5}
                value={strip().eq.mid}
                text={strip().eq.mid.toFixed(1)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, mid: v } }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, mid: 0 } }))}
              />
              <ParamRow
                label="High"
                ariaLabel="High shelf"
                min={-15}
                max={15}
                step={0.5}
                value={strip().eq.high}
                text={strip().eq.high.toFixed(1)}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, high: v } }))}
                onReset={() => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, high: 0 } }))}
              />
            </Section>

            <Section
              title="Compressor"
              open={isOpen("comp")}
              onToggle={() => toggleSection("comp")}
              switchLabel="On"
              switchOn={strip().comp.on}
              onSwitch={(on) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, on } }))}
            >
              <ParamRow
                label="Threshold"
                ariaLabel="Compressor threshold"
                min={-60}
                max={0}
                step={1}
                value={strip().comp.threshold}
                text={strip().comp.threshold.toFixed(0) + " dB"}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, threshold: v } }))}
              />
              <ParamRow
                label="Ratio"
                ariaLabel="Compressor ratio"
                min={1}
                max={20}
                step={0.5}
                value={strip().comp.ratio}
                text={strip().comp.ratio.toFixed(1) + " : 1"}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, ratio: v } }))}
              />
              <ParamRow
                label="Attack"
                ariaLabel="Compressor attack"
                min={1}
                max={100}
                step={1}
                value={strip().comp.attack}
                text={strip().comp.attack.toFixed(0) + " ms"}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, attack: v } }))}
              />
              <ParamRow
                label="Release"
                ariaLabel="Compressor release"
                min={20}
                max={1000}
                step={10}
                value={strip().comp.release}
                text={strip().comp.release.toFixed(0) + " ms"}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, release: v } }))}
              />
              <ParamRow
                label="Makeup"
                ariaLabel="Compressor makeup gain"
                min={0}
                max={24}
                step={0.5}
                value={strip().comp.makeup}
                text={strip().comp.makeup.toFixed(1) + " dB"}
                onInput={(v) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, makeup: v } }))}
              />
            </Section>
          </div>

          <div class="inspector-body" showIf={tab() === "routing"}>
            <Section title="Master limiter" open={isOpen("limiter")} onToggle={() => toggleSection("limiter")}>
              <label class="check-row">
                <input
                  type="checkbox"
                  checked={board().master.limiter}
                  onChange={(e: Event) =>
                    patchMaster((m) => ({ ...m, limiter: (e.target as HTMLInputElement).checked }))
                  }
                />
                Limiter on
              </label>
              <ParamRow
                label="Ceiling"
                ariaLabel="Limiter ceiling"
                min={-12}
                max={0}
                step={0.1}
                value={board().master.ceiling}
                text={board().master.ceiling.toFixed(1) + " dB"}
                onInput={(v) => patchMaster((m) => ({ ...m, ceiling: v }))}
              />
            </Section>

            <Section title="Outputs" open={isOpen("outputs")} onToggle={() => toggleSection("outputs")}>
              <Field
                label="Main mix"
                htmlFor="main-pair"
                hint={
                  audio().running ? "On " + (audio().device || "the output device") : "Waiting for the audio engine."
                }
              >
                <Select
                  id="main-pair"
                  label="Main output channels"
                  value={String(board().master.mainChannel)}
                  options={channelPairs(audio().channels)}
                  onChange={(v) => patchMaster((m) => ({ ...m, mainChannel: Number(v) }))}
                />
              </Field>
              <Field
                label="Monitor mix"
                htmlFor="monitor-pair"
                hint={
                  mon() && mon().mode === "device"
                    ? "On " + (mon().device || "the monitor device")
                    : "No monitor device chosen, so it plays on the main output."
                }
              >
                <Select
                  id="monitor-pair"
                  label="Monitor output channels"
                  value={String(board().master.monitorChannel)}
                  options={channelPairs(mon() && mon().mode === "device" ? mon().channels : audio().channels)}
                  onChange={(v) => patchMaster((m) => ({ ...m, monitorChannel: Number(v) }))}
                />
              </Field>
              <p class="field-warn" showIf={!!mon() && !!mon().error}>
                {"Monitor output: " + (mon() ? mon().error : "")}
              </p>
              <p class="field-warn" showIf={!!mon() && mon().rateMismatch}>
                The monitor device runs at a different sample rate. Set both devices to the same rate for the best
                quality.
              </p>
            </Section>

            <Section title="Latency" open={isOpen("latency")} onToggle={() => toggleSection("latency")}>
              <div class="latency-lines">
                <div class="latency-line">
                  <span class="strip-row-label">Main output</span>
                  <LiveText class="mono" text={latOut()} />
                </div>
                <div class="latency-line">
                  <span class="strip-row-label">Mode</span>
                  <LiveText class="mono" text={latMode()} />
                </div>
                <div class="latency-line">
                  <span class="strip-row-label">Inputs</span>
                  <LiveText class="mono" text={latInputs()} />
                </div>
                <div class="latency-line">
                  <span class="strip-row-label">Monitor</span>
                  <LiveText class="mono" text={latMonitor()} />
                </div>
              </div>
              <Link class="krate-button krate-button-secondary" href="/latency">
                <Icon name="lucide:timer" />
                Latency tools
              </Link>
            </Section>
          </div>
        </aside>
      </div>
      <Menu
        id="scene-menu"
        open={sceneMenu()}
        x={sceneMenuX()}
        y={sceneMenuY()}
        items={sceneItems()}
        onClose={() => setSceneMenu(false)}
      />
    </section>
  );
}
