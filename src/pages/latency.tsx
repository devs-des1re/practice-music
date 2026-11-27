import { createSignal, createEffect, createMemo, onMount, onCleanup } from "@krate/runtime";
import { Topbar } from "../components/blocks/topbar";
import { Devices, GetSettings, SaveSettings } from "../../api/host.go";
import {
  AudioStream,
  Latency,
  StartAudio,
  StopAudio,
  ClockProbe,
  Click,
  ResetLatency,
  SetMetronome,
  MeasureLoopback,
  GetAudioStats,
} from "../../api/audio.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Readout } from "../components/ui/readout";
import { RunGlyph } from "../components/ui/glyphs";
import { Notice } from "../components/ui/notice";
import { emptyDevices } from "../lib/devices";
import { formatMs } from "../lib/format";
import { logger } from "../lib/logger";
import type { AudioState, DeviceList, LatencyState, LoopbackResult } from "../lib/types";
import { NumberInput } from "../components/ui/number-input";
import { ModalHost } from "../components/blocks/modal-host";
import { ContextHost } from "../components/blocks/context-host";
import { TooltipHost } from "../components/ui/tooltip";

const emptyAudio: AudioState = {
  running: false,
  device: "",
  deviceId: "",
  sampleRate: 0,
  channels: 0,
  bufferFramesRequested: 0,
  bufferRange: null,
  error: "",
  mode: "",
  bufferFrames: 0,
  periodFrames: 0,
  periodMs: 0,
  streamLatencyMs: 0,
  format: "",
  notice: "",
  metronome: { running: false, bpm: 120, volume: 0.5, beatsPerBar: 4, subdivision: 1, subLevel: 0.55, accents: [3, 2, 2, 2], polyBeats: 0, polyLevel: 0.8, playBars: 1, silentBars: 0 },
  capture: null,
  monitor: null,
};

const emptyStats = { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };

const emptyLatency: LatencyState = {
  snapshot: {
    hasLast: false,
    last: { id: 0, uiToHostMs: 0, hostToEngineMs: 0, engineQueueMs: 0, outputMs: 0, totalMs: 0, bufferFrames: 0, sampleRate: 0, bufferPeriodMs: 0 },
    recent: [],
    total: emptyStats,
    uiToHost: emptyStats,
    hostToEngine: emptyStats,
    engineQueue: emptyStats,
    output: emptyStats,
  },
  engineClockErrorMs: 0,
};

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function LatencyPage() {
  const [audio, setAudio] = createSignal<AudioState>(emptyAudio);
  const [snap, setSnap] = createSignal<LatencyState>(emptyLatency);
  const [offset, setOffset] = createSignal(0);
  const [uiError, setUiError] = createSignal(-1);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [batch, setBatch] = createSignal(false);
  const [bpm, setBpm] = createSignal(120);
  const [volume, setVolume] = createSignal(0.5);
  const [beats, setBeats] = createSignal(4);
  const [devices, setDevices] = createSignal<DeviceList>(emptyDevices);
  const [inputId, setInputId] = createSignal("");
  const [loopBusy, setLoopBusy] = createSignal(false);
  const [loop, setLoop] = createSignal<LoopbackResult | null>(null);
  const [lateWakes, setLateWakes] = createSignal(0);
  const [modeSetting, setModeSetting] = createSignal("");

  createEffect(() => {
    const next = AudioStream();
    if (next) setAudio(next);
  });
  createEffect(() => {
    const next = Latency();
    if (next) setSnap(next);
  });
  createEffect(() => {
    if (audio().running) {
      Devices()
        .then((list) => setDevices(list))
        .catch((e) => logger.error("device listing failed", e));
    }
  });

  async function syncClock() {
    const samples: { rtt: number; offset: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now() * 1000;
      const host = await ClockProbe();
      const t1 = performance.now() * 1000;
      samples.push({ rtt: t1 - t0, offset: host - (t0 + t1) / 2 });
    }
    samples.sort((a, b) => a.rtt - b.rtt);
    setOffset(samples[0].offset);
    setUiError(samples[0].rtt / 2 / 1000);
  }

  createEffect(() => {
    if (!audio().running) return;
    const timer = setInterval(() => {
      GetAudioStats()
        .then((s) => setLateWakes(s.lateWakes))
        .catch(() => undefined);
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });

  async function switchMode(next: string) {
    setError("");
    try {
      const doc = await GetSettings();
      doc.settings.audio.mode = next;
      await SaveSettings(doc.settings);
      setModeSetting(next);
    } catch (e) {
      setError(describe(e));
    }
  }

  onMount(() => {
    GetSettings()
      .then((doc) => setModeSetting(doc.settings.audio.mode))
      .catch((e) => logger.error("could not read settings", e));
    syncClock().catch((e) => logger.error("clock sync failed", e));
  });

  async function toggleAudio() {
    setBusy(true);
    setError("");
    try {
      if (audio().running) await StopAudio();
      else await StartAudio();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  function pressTime(e: Event | null): number {
    const now = performance.now();
    const stamp = e ? e.timeStamp : now;
    const usable = stamp > 0 && stamp <= now + 1;
    return (usable ? stamp : now) * 1000;
  }

  async function fire(e: Event | null) {
    const at = pressTime(e);
    try {
      await Click(at, offset());
    } catch (err) {
      setError(describe(err));
    }
  }

  function onPress(e: Event) {
    if (!audio().running) return;
    fire(e);
  }

  function onKey(e: KeyboardEvent) {
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    onPress(e);
  }

  async function runBatch() {
    setBatch(true);
    setError("");
    try {
      await ResetLatency();
      for (let i = 0; i < 20; i++) {
        await fire(null);
        await sleep(300);
      }
    } finally {
      setBatch(false);
    }
  }

  async function applyMetronome(running: boolean) {
    setError("");
    try {
      await SetMetronome(bpm(), volume(), beats(), running);
    } catch (e) {
      setError(describe(e));
    }
  }

  async function runLoopback() {
    setLoopBusy(true);
    setLoop(null);
    setError("");
    try {
      setLoop(await MeasureLoopback(inputId(), 6));
    } catch (e) {
      setError(describe(e));
    } finally {
      setLoopBusy(false);
    }
  }

  const running = createMemo(() => audio().running);
  const device = createMemo(() => audio().device || "-");
  const rate = createMemo(() => (audio().sampleRate ? audio().sampleRate + " Hz" : "-"));
  const period = createMemo(() => formatMs(snap().snapshot.last.bufferPeriodMs, snap().snapshot.hasLast));
  const uiClock = createMemo(() => (uiError() < 0 ? "-" : uiError().toFixed(2) + " ms"));
  const engineClock = createMemo(() => (snap().engineClockErrorMs > 0 ? snap().engineClockErrorMs.toFixed(2) + " ms" : "-"));
  const inputOptions = createMemo(() =>
    [{ value: "", label: "System default input" }].concat(
      devices().devices.filter((d) => d.direction === "input").map((d) => ({ value: d.id, label: d.name })),
    ),
  );
  const modeLabel = createMemo(() => ({ shared: "Shared", lowlatency: "Low-latency shared", exclusive: "Exclusive" })[audio().mode] || "-");
  const periodText = createMemo(() => (audio().periodMs ? audio().periodMs.toFixed(2) + " ms (" + audio().periodFrames + " frames)" : "-"));
  const lateText = createMemo(() => String(lateWakes()));
  const notice = createMemo(() => audio().notice || "");
  const audioError = createMemo(() => audio().error || "");
  const loopSummary = createMemo(() => {
    const r = loop();
    if (!r) return "";
    if (r.detected === 0) return "No click was heard on the input (" + r.missed + " missed). Place the microphone next to the speaker or use a cable loopback, and raise the output volume.";
    return "Detected " + r.detected + " of " + (r.detected + r.missed) + " clicks. Median " + (r.medianMs ?? 0).toFixed(1) + " ms, range " + (r.minMs ?? 0).toFixed(1) + " to " + (r.maxMs ?? 0).toFixed(1) + " ms.";
  });

  return (
    <div class="screen">
      <ModalHost />
      <ContextHost />
      <TooltipHost />
      <Topbar />
      <div class="viewport">
    <main class="page">
      <header class="page-head">
        <h1 class="page-title">
          <Icon name="lucide:timer" />
          Latency
        </h1>
        <div class="actions">
          <button class="krate-button krate-button-secondary" type="button" disabled={busy()} onClick={toggleAudio}>
            <Icon name="lucide:power" />
            {running() ? "Stop audio" : "Start audio"}
          </button>
        </div>
      </header>

      <div showIf={!!error()}>
        <Notice tone="bad" text={error()} />
      </div>
      <div showIf={!!audioError()}>
        <Notice tone="bad" title="Audio output problem" text={audioError()} />
      </div>

      <div showIf={!!notice()}>
        <Notice tone="warn" title="Output mode changed" text={notice()} />
      </div>

      <div class="fill latency-ws">
        <div class="col scroll-col">
          <Panel hue="mixer">
            <PanelHead title="Audio output" />
            <PanelBody>
              <Field label="Output mode" htmlFor="out-mode" hint="Switching restarts the stream.">
                <Select
                  id="out-mode"
                  value={modeSetting()}
                  options={[
                    { value: "shared", label: "Shared, standard" },
                    { value: "lowlatency", label: "Low-latency shared (Windows)" },
                    { value: "exclusive", label: "Exclusive (Windows)" },
                  ]}
                  onChange={(v) => switchMode(v)}
                />
              </Field>
              <div class="readout-grid">
                <Readout label="Active mode" value={modeLabel()} />
                <Readout label="Late wakes" value={lateText()} />
              </div>
              <Readout label="Callback period" value={periodText()} />
              <div class="readout-grid">
                <Readout label="Device" value={device()} />
                <Readout label="Sample rate" value={rate()} />
              </div>
              <div class="readout-grid">
                <Readout label="Measured period" value={period()} />
                <Readout label="UI clock error" value={uiClock()} />
                <Readout label="Engine clock error" value={engineClock()} />
              </div>
              <p class="field-hint">Device, sample rate and buffer size are set in Settings.</p>
            </PanelBody>
          </Panel>

          <Panel hue="mixer">
            <PanelHead title="Metronome" />
            <PanelBody>
              <div class="field-row">
                <Field label="Tempo" htmlFor="metro-bpm">
                  <NumberInput
                    id="metro-bpm"
                    class="krate-input"
                    label="Tempo"
                    value={bpm()}
                    min={20}
                    max={400}
                    decimals={1}
                    onCommit={(v) => {
                      setBpm(v);
                      applyMetronome(audio().metronome.running);
                    }}
                  />
                </Field>
                <Field label="Beats per bar" htmlFor="metro-beats">
                  <NumberInput
                    id="metro-beats"
                    class="krate-input"
                    label="Beats per bar"
                    value={beats()}
                    min={1}
                    max={32}
                    decimals={0}
                    onCommit={(v) => {
                      setBeats(v);
                      applyMetronome(audio().metronome.running);
                    }}
                  />
                </Field>
              </div>
              <Field label="Click volume" htmlFor="metro-volume">
                <input
                  id="metro-volume"
                  class="range"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={String(volume())}
                  onInput={(e: Event) => {
                    setVolume(Number((e.target as HTMLInputElement).value));
                    applyMetronome(audio().metronome.running);
                  }}
                />
              </Field>
              <div class="actions">
                <button
                  class="krate-button krate-button-primary"
                  type="button"
                  disabled={!running()}
                  onClick={() => applyMetronome(!audio().metronome.running)}
                >
                  <RunGlyph on={audio().metronome.running} offLabel="Start metronome" onLabel="Stop metronome" />
                </button>
              </div>
            </PanelBody>
          </Panel>
        </div>

        <div class="col scroll-col">
          <Panel hue="mixer">
            <PanelHead title="Button to sound" />
            <PanelBody>
              <div class="readout-grid">
                <Readout label="Last" value={formatMs(snap().snapshot.last.totalMs, snap().snapshot.hasLast)} size="display" />
              </div>
              <div class="actions">
                <button
                  class="krate-button krate-button-primary krate-button-lg"
                  type="button"
                  disabled={!running()}
                  onPointerDown={onPress}
                  onKeyDown={onKey}
                >
                  <Icon name="lucide:hand" />
                  Press for a click
                </button>
                <button class="krate-button krate-button-secondary" type="button" disabled={!running() || batch()} onClick={runBatch}>
                  <Icon name="lucide:repeat" />
                  Run 20 clicks
                </button>
                <button class="krate-button krate-button-secondary" type="button" onClick={() => ResetLatency()}>
                  <Icon name="lucide:eraser" />
                  Clear
                </button>
              </div>
              <table class="device-table stage-table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Median</th>
                    <th>95th</th>
                    <th>Max</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>UI to Go host</td>
                    <td class="num">{formatMs(snap().snapshot.uiToHost.medianMs, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.uiToHost.p95Ms, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.uiToHost.maxMs, snap().snapshot.hasLast)}</td>
                  </tr>
                  <tr>
                    <td>Go host to engine</td>
                    <td class="num">{formatMs(snap().snapshot.hostToEngine.medianMs, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.hostToEngine.p95Ms, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.hostToEngine.maxMs, snap().snapshot.hasLast)}</td>
                  </tr>
                  <tr>
                    <td>Wait for audio callback</td>
                    <td class="num">{formatMs(snap().snapshot.engineQueue.medianMs, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.engineQueue.p95Ms, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.engineQueue.maxMs, snap().snapshot.hasLast)}</td>
                  </tr>
                  <tr>
                    <td>Driver output buffer</td>
                    <td class="num">{formatMs(snap().snapshot.output.medianMs, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.output.p95Ms, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.output.maxMs, snap().snapshot.hasLast)}</td>
                  </tr>
                  <tr class="total-row">
                    <td>Total</td>
                    <td class="num">{formatMs(snap().snapshot.total.medianMs, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.total.p95Ms, snap().snapshot.hasLast)}</td>
                    <td class="num">{formatMs(snap().snapshot.total.maxMs, snap().snapshot.hasLast)}</td>
                  </tr>
                </tbody>
              </table>
              <p class="field-hint">The driver figure is the driver's own estimate. It excludes converter and amp delay.</p>
            </PanelBody>
          </Panel>

          <Panel hue="mixer">
            <PanelHead title="Loopback measurement" />
            <PanelBody>
              <Field label="Input" htmlFor="loop-input" hint="Use a cable from an output, or a microphone next to the speaker.">
                <Select id="loop-input" value={inputId()} options={inputOptions()} onChange={(v) => setInputId(v)} />
              </Field>
              <div class="actions">
                <button class="krate-button krate-button-secondary" type="button" disabled={!running() || loopBusy()} onClick={runLoopback}>
                  <Icon name="lucide:activity" />
                  {loopBusy() ? "Measuring" : "Measure round trip"}
                </button>
              </div>
              <p class="field-hint" showIf={!!loopSummary()}>
                {loopSummary()}
              </p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </main>
      </div>
    </div>
  );
}
