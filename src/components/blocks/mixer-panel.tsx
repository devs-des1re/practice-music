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

function hueOf(kind: string): string {
  if (kind === "song") return "player";
  if (kind === "click") return "metronome";
  return "mixer";
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
    <section class="panel ws-panel" data-hue="mixer" data-panel="mixer" aria-label="Mixer">
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
          <button class="krate-button krate-button-secondary krate-button-icon krate-button-sm" type="button" aria-label="Save as a new scene" title="Save as a new scene" onClick={saveAs}>
            <Icon name="lucide:save" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Update the current scene" title="Update the current scene" disabled={active().id === 0 || !active().modified} onClick={updateActive}>
            <Icon name="lucide:refresh-cw" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Delete the current scene" title="Delete the current scene" disabled={active().id === 0} onClick={removeActive}>
            <Icon name="lucide:trash-2" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Clear clip lights" title="Clear clip lights" onClick={() => guard(() => ResetMeters())}>
            <Icon name="lucide:eraser" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Reset the mixer" title="Reset the mixer" onClick={resetAll}>
            <Icon name="lucide:rotate-ccw" />
          </button>
        </div>
      </header>

      <div class="panel-notices">
        <div showIf={!!error()}>
          <Notice tone="bad" text={error()} />
        </div>
        <div showIf={!!info() && !error()}>
          <Notice tone="ok" text={info()} />
        </div>
      </div>

      <div class="mixer" data-inspect={inspect() ? "true" : "false"}>
        <div class="strips">
          {board().strips.map((s) => (
            <section
              class="strip"
              key={s.index}
              data-kind={s.kind}
              data-hue={hueOf(s.kind)}
              data-selected={selected() === s.index ? "true" : "false"}
              data-muted={s.mute ? "true" : "false"}
              aria-label={s.name + " channel"}
              onClick={() => setSelected(s.index)}
            >
              <header class="strip-head">
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
                <button
                  class="strip-inspect"
                  type="button"
                  aria-label={"EQ and routing for " + s.name}
                  title="EQ, compressor and routing"
                  onClick={() => {
                    setSelected(s.index);
                    setInspect(true);
                  }}
                >
                  <Icon name="lucide:sliders-horizontal" />
                </button>
              </header>

              <div class="strip-body">
                <Meter which={String(s.index)} label={s.name} />
                <input
                  class="fader"
                  type="range"
                  min="-60"
                  max="12"
                  step="0.5"
                  aria-label={s.name + " level"}
                  value={String(s.gain)}
                  onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, gain: numberOf(e) }))}
                  onDoubleClick={() => patchStrip(s.index, (x) => ({ ...x, gain: 0 }))}
                />
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
                  onClick={() => patchStrip(s.index, (x) => ({ ...x, mute: !x.mute }))}
                >
                  <Icon name="lucide:volume-x" />
                </button>
                <button
                  class="strip-toggle"
                  type="button"
                  data-on={s.solo ? "true" : "false"}
                  data-kind="solo"
                  aria-pressed={s.solo}
                  aria-label={"Solo " + s.name}
                  onClick={() => patchStrip(s.index, (x) => ({ ...x, solo: !x.solo }))}
                >
                  <Icon name="lucide:headphones" />
                </button>
              </div>
            </section>
          ))}
        </div>

        <aside class="strip master" data-hue="home" aria-label="Master section">
          <header class="strip-head">
            <span class="strip-title">Master</span>
          </header>
          <div class="master-buses">
            <div class="master-bus">
              <span class="strip-row-label">Main</span>
              <div class="strip-body">
                <Meter which="main" label="Main mix" />
                <input
                  class="fader"
                  type="range"
                  min="-60"
                  max="12"
                  step="0.5"
                  aria-label="Main mix level"
                  value={String(board().master.main)}
                  onInput={(e: Event) => patchMaster((m) => ({ ...m, main: numberOf(e) }))}
                  onDoubleClick={() => patchMaster((m) => ({ ...m, main: 0 }))}
                />
              </div>
              <div class="strip-db mono">{formatDb(board().master.main)}</div>
            </div>
            <div class="master-bus">
              <span class="strip-row-label">Monitor</span>
              <div class="strip-body">
                <Meter which="monitor" label="Monitor mix" />
                <input
                  class="fader"
                  type="range"
                  min="-60"
                  max="12"
                  step="0.5"
                  aria-label="Monitor mix level"
                  value={String(board().master.monitor)}
                  onInput={(e: Event) => patchMaster((m) => ({ ...m, monitor: numberOf(e) }))}
                  onDoubleClick={() => patchMaster((m) => ({ ...m, monitor: 0 }))}
                />
              </div>
              <div class="strip-db mono">{formatDb(board().master.monitor)}</div>
            </div>
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
