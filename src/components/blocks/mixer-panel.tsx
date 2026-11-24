import { createSignal, createEffect } from "@krate/runtime";
import { confirm } from "@krate/app/dialog";
import { AudioStream, StartAudio } from "../../../api/audio.go";
import { Engine } from "../../../api/host.go";
import {
  GetMixer,
  SetMixerStrip,
  SetMixerMaster,
  ResetMixer,
  ResetMeters,
  SessionEpoch,
  ActiveScene,
} from "../../../api/session.go";
import { Scenes, SaveScene, RecallScene, DeleteScene, SceneRevision } from "../../../api/scenes.go";
import { Meter } from "./meter";
import { Fader } from "../ui/fader";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import { Notice } from "../ui/notice";
import { LiveText } from "../ui/live-text";
import { channelPairs, formatDb, sourceOptions } from "../../lib/mixer";
import { logger } from "../../lib/logger";
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

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

const FADER_MARKS = [12, 0, -12, -24, -36, -60];

function toneOf(s: MixerStrip): string {
  if (s.kind === "song") return "1";
  if (s.kind === "click") return "2";
  return String(3 + (s.index % 4));
}

function sourceText(s: MixerStrip): string {
  if (s.kind === "song") return "Song player";
  if (s.kind === "click") return "Metronome";
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
  const [sceneName, setSceneName] = createSignal("");
  const [latOut, setLatOut] = createSignal("audio stopped");
  const [latMode, setLatMode] = createSignal("-");
  const [latInputs, setLatInputs] = createSignal("no input device chosen");
  const [latMonitor, setLatMonitor] = createSignal("on the main output");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [tab, setTab] = createSignal("channel");
  const [inspectorTitle, setInspectorTitle] = createSignal("Channel");
  const [inspect, setInspect] = createSignal(false);
  const [ceilingText, setCeilingText] = createSignal("-0.3 dB");
  const strip = () => board().strips[selected()] || noStrip;
  const cap = () => audio().capture ?? noLink;
  const mon = () => audio().monitor ?? noLink;
  const sending: Record<string, boolean> = {};
  const dirty: Record<string, boolean> = {};

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

  createEffect(() => {
    SessionEpoch();
    GetMixer()
      .then((next) => setBoard(next))
      .catch((e) => logger.error("mixer state failed", e));
  });

  createEffect(() => {
    SceneRevision();
    Scenes()
      .then((list) => setScenes(list))
      .catch((e) => logger.error("scene list failed", e));
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logger.error("mixer action failed", e);
      setError(describe(e));
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
      logger.error("mixer update failed", e);
      setError(describe(e));
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

  function numberOf(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  function recall(id: number) {
    guard(async () => {
      const scene = await RecallScene(id);
      setInfo("Scene " + scene.name + " recalled.");
    });
  }

  function saveAs() {
    const name = sceneName().trim();
    if (!name) {
      setError("Give the scene a name first.");
      return;
    }
    guard(async () => {
      const scene = await SaveScene(name);
      setSceneName("");
      setInfo("Scene " + scene.name + " saved.");
    });
  }

  function updateActive() {
    const name = active().name;
    if (!name) return;
    guard(async () => {
      const scene = await SaveScene(name);
      setInfo("Scene " + scene.name + " updated.");
    });
  }

  function removeActive() {
    const current = active();
    if (current.id === 0) return;
    guard(async () => {
      const yes = await confirm("Delete scene", "Delete the scene " + current.name + "? This cannot be undone.");
      if (!yes) return;
      await DeleteScene(current.id);
      setInfo("Scene deleted.");
    });
  }

  function resetAll() {
    guard(async () => {
      const yes = await confirm("Reset mixer", "Put every fader, send, EQ and compressor back to its default?");
      if (!yes) return;
      await ResetMixer();
      setInfo("Mixer reset.");
    });
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
            options={[{ value: "0", label: scenes().length === 0 ? "No scenes yet" : "Recall a scene" }].concat(scenes().map((sc) => ({ value: String(sc.id), label: sc.name })))}
            onChange={(v) => {
              if (Number(v)) recall(Number(v));
            }}
          />
          <input
            class="krate-input scene-name"
            type="text"
            placeholder="Scene name"
            aria-label="Scene name"
            maxLength={40}
            value={sceneName()}
            onInput={(e: Event) => setSceneName((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") saveAs();
            }}
          />
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Save as a new scene" data-tip="Save as a new scene" onClick={saveAs}>
            <Icon name="lucide:save" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Update the current scene" data-tip="Update the current scene" disabled={active().id === 0 || !active().modified} onClick={updateActive}>
            <Icon name="lucide:refresh-cw" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Delete the current scene" data-tip="Delete the current scene" disabled={active().id === 0} onClick={removeActive}>
            <Icon name="lucide:trash-2" />
          </button>
          <span class="tool-divider" />
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Clear clip lights" data-tip="Clear clip lights" onClick={() => guard(() => ResetMeters())}>
            <Icon name="lucide:eraser" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Reset the mixer" data-tip="Reset every channel" onClick={resetAll}>
            <Icon name="lucide:rotate-ccw" />
          </button>
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

      <div class="console" data-inspect={inspect() ? "true" : "false"}>
        <div class="channels">
          <div class="loading-state" data-on={board().strips.length === 0 ? "true" : "false"}>
            <Icon name="lucide:loader" />
            Waiting for the audio engine
          </div>
          {board().strips.map((s) => (
            <section
              class="strip"
              key={s.index}
              data-tone={toneOf(s)}
              data-selected={selected() === s.index ? "true" : "false"}
              data-muted={s.mute ? "true" : "false"}
              aria-label={s.name + " channel"}
              onClick={() => setSelected(s.index)}
            >
              <div class="strip-top">
                {s.kind === "input" ? (
                  <input
                    class="strip-name"
                    type="text"
                    maxLength={24}
                    aria-label={"Name of channel " + (s.index + 1)}
                    value={s.name}
                    onChange={(e: Event) => patchStrip(s.index, (x) => ({ ...x, name: (e.target as HTMLInputElement).value }))}
                  />
                ) : (
                  <span class="strip-title">{s.name}</span>
                )}
                <span class="strip-source">{sourceText(s)}</span>
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

              <div class="strip-main">
                <Fader
                  label={s.name + " level"}
                  value={s.gain}
                  min={-60}
                  max={12}
                  step={0.5}
                  marks={FADER_MARKS}
                  onInput={(v) => patchStrip(s.index, (x) => ({ ...x, gain: v }))}
                  onReset={() => patchStrip(s.index, (x) => ({ ...x, gain: 0 }))}
                />
                <Meter which={String(s.index)} label={s.name} />
              </div>
              <div class="strip-db mono">{formatDb(s.gain)}</div>

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

              <button
                class="strip-edit"
                type="button"
                data-on={selected() === s.index && inspect() ? "true" : "false"}
                aria-label={"EQ and routing for " + s.name}
                data-tip="EQ, compressor and routing"
                onClick={() => {
                  setSelected(s.index);
                  setTab("channel");
                  setInspect(true);
                }}
              >
                <Icon name="lucide:sliders-horizontal" />
                Edit
              </button>
            </section>
          ))}
        </div>

        <aside class="strip master" aria-label="Master section">
          <div class="strip-top">
            <span class="strip-title">Master</span>
            <span class="strip-source">Stereo output</span>
          </div>
          <div class="master-buses">
            <div class="master-bus">
              <span class="strip-label">Main</span>
              <div class="strip-main">
                <Fader
                  label="Main mix level"
                  value={board().master.main}
                  min={-60}
                  max={12}
                  step={0.5}
                  marks={FADER_MARKS}
                  onInput={(v) => patchMaster((m) => ({ ...m, main: v }))}
                  onReset={() => patchMaster((m) => ({ ...m, main: 0 }))}
                />
                <Meter which="main" label="Main mix" />
              </div>
              <div class="strip-db mono">{formatDb(board().master.main)}</div>
            </div>
            <div class="master-bus">
              <span class="strip-label">Monitor</span>
              <div class="strip-main">
                <Fader
                  label="Monitor mix level"
                  value={board().master.monitor}
                  min={-60}
                  max={12}
                  step={0.5}
                  marks={FADER_MARKS}
                  onInput={(v) => patchMaster((m) => ({ ...m, monitor: v }))}
                  onReset={() => patchMaster((m) => ({ ...m, monitor: 0 }))}
                />
                <Meter which="monitor" label="Monitor mix" />
              </div>
              <div class="strip-db mono">{formatDb(board().master.monitor)}</div>
            </div>
          </div>
          <div class="master-bottom">
            <div class="limiter-row">
              <button
                class="krate-button krate-button-secondary"
                type="button"
                data-on={board().master.limiter ? "true" : "false"}
                aria-pressed={board().master.limiter}
                data-tip="Master limiter"
                onClick={() => patchMaster((m) => ({ ...m, limiter: !m.limiter }))}
              >
                Limiter
              </button>
              <LiveText class="strip-label" text={ceilingText()} />
            </div>
            <button
              class="strip-edit"
              type="button"
              data-on={inspect() && tab() === "routing" ? "true" : "false"}
              data-tip="Outputs, limiter and latency"
              onClick={() => {
                setTab("routing");
                setInspect(true);
              }}
            >
              <Icon name="lucide:route" />
              Routing
            </button>
          </div>
        </aside>

        <aside class="mixer-inspector" aria-label="Channel settings">
          <header class="inspector-head">
            <LiveText class="inspector-title" text={inspectorTitle()} />
            <div class="segmented">
              <button class="segment" type="button" data-active={tab() === "channel" ? "true" : "false"} onClick={() => setTab("channel")}>
                Channel
              </button>
              <button class="segment" type="button" data-active={tab() === "routing" ? "true" : "false"} onClick={() => setTab("routing")}>
                Routing
              </button>
            </div>
            <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm inspector-close" type="button" aria-label="Close channel settings" onClick={() => setInspect(false)}>
              <Icon name="lucide:x" />
            </button>
          </header>

          <div class="inspector-body" showIf={tab() === "channel"}>
            <div class="stack compact" showIf={strip().kind === "input"}>
              <span class="group-title">Input</span>
              <Select
                id="strip-source"
                label="Input source"
                value={String(strip().source)}
                options={sourceOptions(cap().channels, strip().stereo)}
                onChange={(v) => patchStrip(selected(), (x) => ({ ...x, source: Number(v) }))}
              />
              <label class="check-row">
                <input type="checkbox" checked={strip().stereo} onChange={(e: Event) => patchStrip(selected(), (x) => ({ ...x, stereo: (e.target as HTMLInputElement).checked }))} />
                Stereo pair
              </label>
            </div>

            <div class="inspector-rows">
              <span class="group-title">Levels</span>
              <label class="strip-row">
                <span class="strip-row-label">Pan</span>
                <input class="range" type="range" min="-1" max="1" step="0.01" aria-label="Pan" value={String(strip().pan)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, pan: numberOf(e) }))} onDoubleClick={() => patchStrip(selected(), (x) => ({ ...x, pan: 0 }))} />
                <span class="strip-row-value mono">{panText(strip().pan)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Main</span>
                <input class="range" type="range" min="-60" max="12" step="0.5" aria-label="Send to main" value={String(strip().main)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, main: numberOf(e) }))} />
                <span class="strip-row-value mono">{formatDb(strip().main)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Monitor</span>
                <input class="range" type="range" min="-60" max="12" step="0.5" aria-label="Send to monitor" value={String(strip().monitor)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, monitor: numberOf(e) }))} />
                <span class="strip-row-value mono">{formatDb(strip().monitor)}</span>
              </label>
            </div>

            <div class="inspector-rows">
              <span class="group-title">Equaliser</span>
              <label class="strip-row">
                <span class="strip-row-label">Low</span>
                <input class="range" type="range" min="-15" max="15" step="0.5" aria-label="Low shelf" value={String(strip().eq.low)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, low: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().eq.low.toFixed(1)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Mid</span>
                <input class="range" type="range" min="-15" max="15" step="0.5" aria-label="Mid band" value={String(strip().eq.mid)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, mid: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().eq.mid.toFixed(1)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">High</span>
                <input class="range" type="range" min="-15" max="15" step="0.5" aria-label="High shelf" value={String(strip().eq.high)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, eq: { ...x.eq, high: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().eq.high.toFixed(1)}</span>
              </label>
            </div>

            <div class="inspector-rows">
              <label class="check-row group-title">
                <input type="checkbox" checked={strip().comp.on} onChange={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, on: (e.target as HTMLInputElement).checked } }))} />
                Compressor
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Threshold</span>
                <input class="range" type="range" min="-60" max="0" step="1" aria-label="Compressor threshold" value={String(strip().comp.threshold)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, threshold: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().comp.threshold.toFixed(0)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Ratio</span>
                <input class="range" type="range" min="1" max="20" step="0.5" aria-label="Compressor ratio" value={String(strip().comp.ratio)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, ratio: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().comp.ratio.toFixed(1)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Attack</span>
                <input class="range" type="range" min="1" max="100" step="1" aria-label="Compressor attack" value={String(strip().comp.attack)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, attack: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().comp.attack.toFixed(0)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Release</span>
                <input class="range" type="range" min="20" max="1000" step="10" aria-label="Compressor release" value={String(strip().comp.release)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, release: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().comp.release.toFixed(0)}</span>
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Makeup</span>
                <input class="range" type="range" min="0" max="24" step="0.5" aria-label="Compressor makeup gain" value={String(strip().comp.makeup)} onInput={(e: Event) => patchStrip(selected(), (x) => ({ ...x, comp: { ...x.comp, makeup: numberOf(e) } }))} />
                <span class="strip-row-value mono">{strip().comp.makeup.toFixed(1)}</span>
              </label>
            </div>
          </div>

          <div class="inspector-body" showIf={tab() === "routing"}>
            <div class="inspector-rows">
              <span class="group-title">Master limiter</span>
              <label class="check-row">
                <input type="checkbox" checked={board().master.limiter} onChange={(e: Event) => patchMaster((m) => ({ ...m, limiter: (e.target as HTMLInputElement).checked }))} />
                Limiter
              </label>
              <label class="strip-row">
                <span class="strip-row-label">Ceiling</span>
                <input class="range" type="range" min="-12" max="0" step="0.1" aria-label="Limiter ceiling" value={String(board().master.ceiling)} onInput={(e: Event) => patchMaster((m) => ({ ...m, ceiling: numberOf(e) }))} />
                <span class="strip-row-value mono">{board().master.ceiling.toFixed(1)}</span>
              </label>
            </div>
            <Field label="Main mix" htmlFor="main-pair" hint={audio().running ? "On " + (audio().device || "the output device") : "Waiting for the audio engine."}>
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
              hint={mon() && mon().mode === "device" ? "On " + (mon().device || "the monitor device") : "No monitor device chosen, so it plays on the main output."}
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
              The monitor device runs at a different sample rate. Set both devices to the same rate for the best quality.
            </p>
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
          </div>
        </aside>
      </div>
    </section>
  );
}
