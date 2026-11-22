import { createSignal, createEffect } from "@krate/runtime";
import { confirm } from "@krate/app/dialog";
import { AudioStream, StartAudio } from "../../api/audio.go";
import { Engine } from "../../api/host.go";
import {
  GetMixer,
  SetMixerStrip,
  SetMixerMaster,
  ResetMixer,
  ResetMeters,
  SessionEpoch,
  ActiveScene,
} from "../../api/session.go";
import { Scenes, SaveScene, RecallScene, DeleteScene, SceneRevision } from "../../api/scenes.go";
import { Meter } from "../components/blocks/meter";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Notice } from "../components/ui/notice";
import { LiveText } from "../components/ui/live-text";
import { channelPairs, formatDb, sourceOptions } from "../lib/mixer";
import { logger } from "../lib/logger";
import type { AudioState, MixerBoard, MixerMaster, MixerStrip, SceneInfo, SceneStatus } from "../lib/types";

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

function panText(pan: number): string {
  if (Math.abs(pan) < 0.02) return "C";
  return (pan < 0 ? "L" : "R") + Math.round(Math.abs(pan) * 100);
}

function latencyText(audio: AudioState): string {
  if (!audio.running) return "audio stopped";
  const out = audio.streamLatencyMs > 0 ? audio.streamLatencyMs : audio.periodMs;
  return out > 0 ? out.toFixed(1) + " ms" : "not reported";
}

export default function MixerPage() {
  const [board, setBoard] = createSignal<MixerBoard>(emptyBoard);
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [scenes, setScenes] = createSignal<SceneInfo[]>([]);
  const [active, setActive] = createSignal<SceneStatus>({ id: 0, name: "", modified: false });
  const [sceneName, setSceneName] = createSignal("");
  const [statusText, setStatusText] = createSignal("No scene loaded");
  const [latOut, setLatOut] = createSignal("audio stopped");
  const [latMode, setLatMode] = createSignal("-");
  const [latInputs, setLatInputs] = createSignal("no input device chosen");
  const [latMonitor, setLatMonitor] = createSignal("on the main output");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
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
    const a = active();
    setStatusText(a.id !== 0 ? a.name + (a.modified ? " (changed)" : "") : "No scene loaded");
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
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Mixer</h1>
          <p class="page-sub">Song, click and kit inputs, with a main mix for the amp and a monitor mix for headphones.</p>
        </div>
        <div class="actions">
          <button class="krate-button krate-button-secondary" type="button" onClick={() => guard(() => ResetMeters())}>
            Clear clip lights
          </button>
          <button class="krate-button krate-button-ghost" type="button" onClick={resetAll}>
            Reset mixer
          </button>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Mixer" text={error()} />
      </div>
      <div showIf={!!info() && !error()}>
        <Notice tone="ok" title="Mixer" text={info()} />
      </div>
      <div showIf={!audio().running && !error()}>
        <Notice tone="info" title="Audio engine" text="Starting the audio engine. Faders work now and take effect as soon as it is running." />
      </div>

      <Panel>
        <PanelHead title="Scenes">
          <LiveText class="scene-status mono" text={statusText()} />
        </PanelHead>
        <PanelBody>
          <div class="scene-list">
            {scenes().length === 0 ? <span class="empty">Save the current mix, routing and metronome as a scene, for example Lesson, Solo practice or Headphones only.</span> : null}
            {scenes().map((sc) => (
              <button class="scene-button" type="button" key={sc.id} data-active={active().id === sc.id ? "true" : "false"} onClick={() => recall(sc.id)}>
                {sc.name}
              </button>
            ))}
          </div>
          <div class="toolbar">
            <input
              class="krate-input grow"
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
            <button class="krate-button krate-button-primary" type="button" onClick={saveAs}>
              Save as scene
            </button>
            <button class="krate-button krate-button-secondary" type="button" disabled={active().id === 0 || !active().modified} onClick={updateActive}>
              Update current
            </button>
            <button class="krate-button krate-button-ghost" type="button" disabled={active().id === 0} onClick={removeActive}>
              Delete
            </button>
          </div>
        </PanelBody>
      </Panel>

      <div class="mixer">
        <div class="strips">
          {board().strips.map((s) => (
            <section class="strip" key={s.index} data-kind={s.kind} data-muted={s.mute ? "true" : "false"} aria-label={s.name + " channel"}>
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
              </header>

              <div class="strip-body">
                <Meter which={String(s.index)} label={s.name} height={176} />
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
                  M
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
                  S
                </button>
              </div>

              <label class="strip-row">
                <span class="strip-row-label">Pan</span>
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
                <span class="strip-row-value mono">{panText(s.pan)}</span>
              </label>

              <label class="strip-row">
                <span class="strip-row-label">Main</span>
                <input
                  class="range"
                  type="range"
                  min="-60"
                  max="12"
                  step="0.5"
                  aria-label={s.name + " send to main"}
                  value={String(s.main)}
                  onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, main: numberOf(e) }))}
                />
                <span class="strip-row-value mono">{formatDb(s.main)}</span>
              </label>

              <label class="strip-row">
                <span class="strip-row-label">Mon</span>
                <input
                  class="range"
                  type="range"
                  min="-60"
                  max="12"
                  step="0.5"
                  aria-label={s.name + " send to monitor"}
                  value={String(s.monitor)}
                  onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, monitor: numberOf(e) }))}
                />
                <span class="strip-row-value mono">{formatDb(s.monitor)}</span>
              </label>

              {s.kind === "input" ? (
                <div class="strip-source">
                  <select
                    class="krate-native-select"
                    id={"source-" + s.index}
                    aria-label={s.name + " source"}
                    onChange={(e: Event) => patchStrip(s.index, (x) => ({ ...x, source: Number((e.target as HTMLSelectElement).value) }))}
                  >
                    {sourceOptions(cap().channels, s.stereo).map((o) => (
                      <option key={o.value} value={o.value} selected={o.value === String(s.source)}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <label class="check-row">
                    <input type="checkbox" checked={s.stereo} onChange={(e: Event) => patchStrip(s.index, (x) => ({ ...x, stereo: (e.target as HTMLInputElement).checked }))} />
                    Stereo pair
                  </label>
                </div>
              ) : null}

              <details class="strip-more">
                <summary>EQ and dynamics</summary>
                <label class="strip-row">
                  <span class="strip-row-label">Low</span>
                  <input class="range" type="range" min="-15" max="15" step="0.5" aria-label={s.name + " low shelf"} value={String(s.eq.low)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, eq: { ...x.eq, low: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.eq.low.toFixed(1)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Mid</span>
                  <input class="range" type="range" min="-15" max="15" step="0.5" aria-label={s.name + " mid band"} value={String(s.eq.mid)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, eq: { ...x.eq, mid: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.eq.mid.toFixed(1)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">High</span>
                  <input class="range" type="range" min="-15" max="15" step="0.5" aria-label={s.name + " high shelf"} value={String(s.eq.high)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, eq: { ...x.eq, high: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.eq.high.toFixed(1)}</span>
                </label>
                <label class="check-row">
                  <input type="checkbox" checked={s.comp.on} onChange={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, on: (e.target as HTMLInputElement).checked } }))} />
                  Compressor
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Thresh</span>
                  <input class="range" type="range" min="-60" max="0" step="1" aria-label={s.name + " compressor threshold"} value={String(s.comp.threshold)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, threshold: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.comp.threshold.toFixed(0)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Ratio</span>
                  <input class="range" type="range" min="1" max="20" step="0.5" aria-label={s.name + " compressor ratio"} value={String(s.comp.ratio)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, ratio: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.comp.ratio.toFixed(1)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Attack</span>
                  <input class="range" type="range" min="1" max="100" step="1" aria-label={s.name + " compressor attack"} value={String(s.comp.attack)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, attack: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.comp.attack.toFixed(0)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Release</span>
                  <input class="range" type="range" min="20" max="1000" step="10" aria-label={s.name + " compressor release"} value={String(s.comp.release)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, release: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.comp.release.toFixed(0)}</span>
                </label>
                <label class="strip-row">
                  <span class="strip-row-label">Makeup</span>
                  <input class="range" type="range" min="0" max="24" step="0.5" aria-label={s.name + " compressor makeup gain"} value={String(s.comp.makeup)} onInput={(e: Event) => patchStrip(s.index, (x) => ({ ...x, comp: { ...x.comp, makeup: numberOf(e) } }))} />
                  <span class="strip-row-value mono">{s.comp.makeup.toFixed(1)}</span>
                </label>
              </details>
            </section>
          ))}
        </div>

        <aside class="strip master" aria-label="Master section">
          <header class="strip-head">
            <span class="strip-title">Master</span>
          </header>
          <div class="master-buses">
            <div class="master-bus">
              <span class="strip-row-label">Main</span>
              <div class="strip-body">
                <Meter which="main" label="Main mix" height={176} />
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
                <Meter which="monitor" label="Monitor mix" height={176} />
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
          <label class="check-row">
            <input type="checkbox" checked={board().master.limiter} onChange={(e: Event) => patchMaster((m) => ({ ...m, limiter: (e.target as HTMLInputElement).checked }))} />
            Limiter
          </label>
          <label class="strip-row">
            <span class="strip-row-label">Ceiling</span>
            <input class="range" type="range" min="-12" max="0" step="0.1" aria-label="Limiter ceiling" value={String(board().master.ceiling)} onInput={(e: Event) => patchMaster((m) => ({ ...m, ceiling: numberOf(e) }))} />
            <span class="strip-row-value mono">{board().master.ceiling.toFixed(1)}</span>
          </label>
        </aside>
      </div>

      <div class="grid-2">
        <Panel>
          <PanelHead title="Outputs" />
          <PanelBody>
            <Field label="Main mix goes to" htmlFor="main-pair" hint={audio().running ? "On " + (audio().device || "the output device") + ". Choose the pair that feeds your amp." : "Start the audio engine to see the output channels."}>
              <Select
                id="main-pair"
                label="Main output channels"
                value={String(board().master.mainChannel)}
                options={channelPairs(audio().channels)}
                onChange={(v) => patchMaster((m) => ({ ...m, mainChannel: Number(v) }))}
              />
            </Field>
            <Field
              label="Monitor mix goes to"
              htmlFor="monitor-pair"
              hint={
                mon() && mon().mode === "device"
                  ? "On " + (mon().device || "the monitor device") + "."
                  : "No separate monitor device is chosen, so the monitor mix plays on the main output. Pick a monitor device in Settings, or use another channel pair here."
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
              The monitor device runs at a different sample rate, so its audio is converted with basic interpolation. Set both devices to the same rate for the best quality.
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHead title="Latency" />
          <PanelBody>
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
            <p class="field-hint">
              Separate input and monitor devices run on their own clocks and add buffering of their own. Measure the real round trip on the Latency page.
            </p>
            <Link class="krate-button krate-button-secondary" href="/latency">
              <Icon name="lucide:timer" />
              Open the latency tools
            </Link>
          </PanelBody>
        </Panel>
      </div>
    </main>
  );
}
