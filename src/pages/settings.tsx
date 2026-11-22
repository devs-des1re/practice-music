import { createSignal, createEffect, createMemo, onMount } from "@krate/runtime";
import { openFolder } from "@krate/app/dialog";
import { LowLatencyDevices } from "../../api/audio.go";
import { Engine, GetSettings, SaveSettings } from "../../api/host.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Toggle } from "../components/ui/toggle";
import { Notice } from "../components/ui/notice";
import { applyScale } from "../lib/appearance";
import { emptyDevices, loadDevices } from "../lib/devices";
import { emptyEngine } from "../lib/engine";
import type { AppSettings, DeviceList, EngineStatus } from "../lib/types";
import { bufferLatencyMs, formatRate } from "../lib/format";
import { logger } from "../lib/logger";

interface LowDevice {
  id: string;
  name: string;
  shared: { minFrames: number; minMs: number } | null;
  exclusive: { supported: boolean; format: string | null; minMs: number | null };
}

const MODE_HINTS: Record<string, string> = {
  shared: "Standard system mixer. Works everywhere but adds about 30 ms on Windows.",
  lowlatency: "Windows shared mode with the smallest buffer the driver allows. Other applications keep playing.",
  exclusive: "Windows exclusive mode. Lowest delay, but other applications are silent while PracticeMusic runs.",
};

const BUFFER_CHOICES = [32, 64, 128, 256, 512, 1024, 2048];
const SCALE_CHOICES = [90, 100, 110, 125, 150];
const FALLBACK_RATES = [44100, 48000, 96000];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function SettingsPage() {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  const [deviceList, setDeviceList] = createSignal<DeviceList>(emptyDevices);
  const [devicesLoaded, setDevicesLoaded] = createSignal(false);
  const [devicesError, setDevicesError] = createSignal("");
  const [devicesLoading, setDevicesLoading] = createSignal(false);
  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });
  const rescan = () =>
    loadDevices({ setList: setDeviceList, setLoaded: setDevicesLoaded, setError: setDevicesError, setLoading: setDevicesLoading });
  createEffect(() => {
    if (engine().state === "running") {
      rescan();
      LowLatencyDevices()
        .then((list) => setLowDevices(list as unknown as LowDevice[]))
        .catch((e) => logger.error("low-latency probe failed", e));
    }
  });
  const [lowDevices, setLowDevices] = createSignal<LowDevice[]>([]);
  const [saved, setSaved] = createSignal<AppSettings | null>(null);
  const [draft, setDraft] = createSignal<AppSettings | null>(null);
  const [notice, setNotice] = createSignal("");
  const [error, setError] = createSignal("");
  const [path, setPath] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);

  onMount(async () => {
    try {
      const doc = await GetSettings();
      setSaved(doc.settings);
      setDraft(clone(doc.settings));
      setNotice(doc.notice);
      setPath(doc.path);
    } catch (e) {
      logger.error("could not read settings", e);
      setError(describe(e));
    }
  });

  function edit(change: (s: AppSettings) => void) {
    const next = clone(draft() as AppSettings);
    change(next);
    setDraft(next);
    setDone(false);
  }

  const dirty = createMemo(() => !!draft() && JSON.stringify(draft()) !== JSON.stringify(saved()));

  function pick(direction: string, selected: string) {
    const host = draft()?.audio.host || "";
    const all = deviceList().devices.filter((d) => d.direction === direction && (host === "" || d.host === host));
    const options = [{ value: "", label: "System default" }].concat(
      all.map((d) => ({ value: d.id, label: d.name + (d.isDefault ? " (default)" : "") })),
    );
    if (selected && !all.some((d) => d.id === selected)) {
      options.push({ value: selected, label: "Not connected: " + selected });
    }
    return options;
  }

  function missing(direction: string, selected: string) {
    if (!selected || !devicesLoaded()) return "";
    const found = deviceList().devices.some((d) => d.id === selected && d.direction === direction);
    return found ? "" : "This device is not connected right now. The saved choice is kept until you change it.";
  }

  const hostOptions = createMemo(() =>
    [{ value: "", label: "Automatic" }].concat(
      deviceList().hosts.filter((h) => h.available).map((h) => ({ value: h.id, label: h.name })),
    ),
  );
  const outputOptions = createMemo(() => pick("output", draft()?.audio.outputDevice || ""));
  const monitorOptions = createMemo(() => pick("output", draft()?.audio.monitorDevice || ""));
  const inputOptions = createMemo(() => pick("input", draft()?.audio.inputDevice || ""));

  const activeOutput = createMemo(() => {
    const id = draft()?.audio.outputDevice || "";
    const host = draft()?.audio.host || "";
    const all = deviceList().devices.filter((d) => d.direction === "output" && (host === "" || d.host === host));
    return all.find((d) => d.id === id) || all.find((d) => d.isDefault) || null;
  });

  const rateOptions = createMemo(() => {
    const dev = activeOutput();
    const rates = (dev && dev.sampleRates.length > 0 ? dev.sampleRates : FALLBACK_RATES).slice();
    const current = draft()?.audio.sampleRate || 0;
    if (current && !rates.includes(current)) rates.push(current);
    rates.sort((a, b) => a - b);
    return [{ value: "0", label: "Device default" }].concat(rates.map((r) => ({ value: String(r), label: formatRate(r) })));
  });

  const bufferOptions = createMemo(() => {
    const range = draft()?.audio.mode === "shared" ? activeOutput()?.bufferFrames || null : null;
    let choices = BUFFER_CHOICES.slice();
    if (range) choices = choices.filter((f) => f >= range.min && f <= range.max);
    const current = draft()?.audio.bufferFrames || 0;
    if (current && !choices.includes(current)) choices.push(current);
    choices.sort((a, b) => a - b);
    return [{ value: "0", label: "Device default" }].concat(choices.map((f) => ({ value: String(f), label: f + " frames" })));
  });

  const lowDevice = createMemo(() => {
    const id = activeOutput()?.id || "";
    return lowDevices().find((d) => d.id === id) || null;
  });

  const modeHint = createMemo(() => {
    const mode = draft()?.audio.mode || "shared";
    const dev = lowDevice();
    let text = MODE_HINTS[mode] || "";
    if (dev && mode === "lowlatency" && dev.shared) text += " This device allows down to " + dev.shared.minMs.toFixed(1) + " ms.";
    if (dev && mode === "exclusive") text += dev.exclusive.supported ? " This device allows down to " + (dev.exclusive.minMs ?? 0).toFixed(1) + " ms (" + dev.exclusive.format + ")." : " This device does not accept exclusive mode.";
    return text;
  });

  const bufferHint = createMemo(() => {
    const dev = activeOutput();
    if (draft()?.audio.mode !== "shared") return "Leave on device default for the smallest stable buffer. A larger value trades delay for safety.";
    if (!dev || !dev.bufferFrames) return "The driver does not report its buffer range.";
    const rate = draft()?.audio.sampleRate || dev.defaultSampleRate || 48000;
    const { min, max } = dev.bufferFrames;
    if (min === max) {
      return "This driver uses a fixed buffer of " + min + " frames (" + bufferLatencyMs(min, rate) + " at " + formatRate(rate) + "). An ASIO or JACK device allows smaller buffers.";
    }
    return "Supported: " + min + " to " + max + " frames (" + bufferLatencyMs(min, rate) + " to " + bufferLatencyMs(max, rate) + ").";
  });

  async function addFolder() {
    try {
      const chosen = await openFolder({ title: "Choose a library folder" });
      if (chosen.length > 0) edit((s) => s.library.folders.push(chosen[0]));
    } catch (e) {
      logger.error("folder dialog failed", e);
      setError(describe(e));
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const doc = await SaveSettings(draft() as AppSettings);
      setSaved(doc.settings);
      setDraft(clone(doc.settings));
      setPath(doc.path);
      setNotice("");
      applyScale(doc.settings.appearance.uiScale);
      setDone(true);
    } catch (e) {
      logger.error("settings were not saved", e);
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setDraft(clone(saved()));
    setError("");
    setDone(false);
  }

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-sub">Audio devices, library folders and appearance. Nothing changes until you save.</p>
        </div>
      </div>

      <div showIf={!!notice()}>
        <Notice tone="warn" title="Settings were reset" text={notice()} />
      </div>
      <div showIf={!!error()}>
        <Notice tone="bad" title="Something went wrong" text={error()} />
      </div>
      <div showIf={!!devicesError()}>
        <Notice tone="warn" title="Device list unavailable" text={devicesError()} />
      </div>
      <div showIf={engine().state !== "running"}>
        <Notice tone="warn" title="Audio engine is not running">
          Device pickers fill in once the engine is up. Saved choices are kept.
        </Notice>
      </div>

      <p class="empty" showIf={!draft() && !error()}>
        Loading settings
      </p>

      <div class="grid-2" showIf={!!draft()}>
        <Panel>
          <PanelHead title="Audio">
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={devicesLoading()} onClick={rescan}>
              <Icon name="lucide:refresh-cw" />
              Rescan
            </button>
          </PanelHead>
          <PanelBody>
          <Field label="Driver" htmlFor="audio-host" hint="Automatic uses the platform default. Choose ASIO, JACK or PipeWire for low latency.">
            <Select
              id="audio-host"
              value={draft()?.audio.host || ""}
              options={hostOptions()}
              onChange={(v) => edit((s) => (s.audio.host = v))}
            />
          </Field>
          <Field label="Output mode" htmlFor="audio-mode" hint={modeHint()}>
            <Select
              id="audio-mode"
              value={draft()?.audio.mode || "shared"}
              options={[
                { value: "shared", label: "Shared, standard" },
                { value: "lowlatency", label: "Low-latency shared (Windows)" },
                { value: "exclusive", label: "Exclusive (Windows)" },
              ]}
              onChange={(v) => edit((s) => (s.audio.mode = v))}
            />
          </Field>
          <Field
            label="Amp output"
            htmlFor="audio-output"
            hint="The device that feeds your drum amp."
            warning={missing("output", draft()?.audio.outputDevice || "")}
          >
            <Select
              id="audio-output"
              value={draft()?.audio.outputDevice || ""}
              options={outputOptions()}
              onChange={(v) => edit((s) => (s.audio.outputDevice = v))}
            />
          </Field>
          <Field
            label="Monitor output"
            htmlFor="audio-monitor"
            hint="Headphones or a second output for the click and your own mix."
            warning={missing("output", draft()?.audio.monitorDevice || "")}
          >
            <Select
              id="audio-monitor"
              value={draft()?.audio.monitorDevice || ""}
              options={monitorOptions()}
              onChange={(v) => edit((s) => (s.audio.monitorDevice = v))}
            />
          </Field>
          <Field
            label="Input"
            htmlFor="audio-input"
            hint="Your kit or audio interface."
            warning={missing("input", draft()?.audio.inputDevice || "")}
          >
            <Select
              id="audio-input"
              value={draft()?.audio.inputDevice || ""}
              options={inputOptions()}
              onChange={(v) => edit((s) => (s.audio.inputDevice = v))}
            />
          </Field>
          <div class="field-row">
            <Field label="Sample rate" htmlFor="audio-rate">
              <Select
                id="audio-rate"
                value={String(draft()?.audio.sampleRate || 0)}
                options={rateOptions()}
                onChange={(v) => edit((s) => (s.audio.sampleRate = Number(v)))}
              />
            </Field>
            <Field label="Buffer size" htmlFor="audio-buffer">
              <Select
                id="audio-buffer"
                value={String(draft()?.audio.bufferFrames || 0)}
                options={bufferOptions()}
                onChange={(v) => edit((s) => (s.audio.bufferFrames = Number(v)))}
              />
            </Field>
          </div>
          <p class="field-hint">{bufferHint()}</p>
          </PanelBody>
        </Panel>

        <div class="stack">
          <Panel>
            <PanelHead title="Library">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={addFolder}>
                <Icon name="lucide:folder-plus" />
                Add folder
              </button>
            </PanelHead>
            <PanelBody>
            <div class="folder-list" showIf={(draft()?.library.folders.length ?? 0) > 0}>
              {(draft()?.library.folders || []).map((f, i) => (
                <div class="folder-row" key={f}>
                  <span class="folder-path" title={f}>
                    {f}
                  </span>
                  <button
                    class="krate-button krate-button-ghost krate-button-sm"
                    type="button"
                    aria-label={"Remove " + f}
                    onClick={() => edit((s) => s.library.folders.splice(i, 1))}
                  >
                    <Icon name="lucide:x" />
                  </button>
                </div>
              ))}
            </div>
            <p class="empty" showIf={(draft()?.library.folders.length ?? 1) === 0}>
              No library folder yet. Add one to keep downloaded songs.
            </p>
            <Toggle
              id="library-normalize"
              label="Normalise loudness on import"
              hint="Applies when songs are added to the library."
              checked={!!draft()?.library.normalizeOnImport}
              onChange={(v) => edit((s) => (s.library.normalizeOnImport = v))}
            />
            <Toggle
              id="library-tool-updates"
              label="Update yt-dlp automatically"
              hint="Checks for a newer release when the app starts. Only applies to the copy PracticeMusic manages."
              checked={!draft()?.library.disableToolUpdates}
              onChange={(v) => edit((s) => (s.library.disableToolUpdates = !v))}
            />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Appearance" />
            <PanelBody>
            <Field label="Interface size" htmlFor="ui-scale" hint="Scales text and controls. Takes effect when saved.">
              <Select
                id="ui-scale"
                value={String(draft()?.appearance.uiScale || 100)}
                options={SCALE_CHOICES.map((p) => ({ value: String(p), label: p + "%" }))}
                onChange={(v) => edit((s) => (s.appearance.uiScale = Number(v)))}
              />
            </Field>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <div class="savebar" showIf={!!draft()}>
        <span class="savebar-text">
          {dirty() ? "Unsaved changes" : done() ? "Saved" : "No changes"}
          <span class="mono muted" showIf={!!path()}>
            {"  " + path()}
          </span>
        </span>
        <div class="actions">
          <button class="krate-button krate-button-ghost" type="button" disabled={!dirty() || busy()} onClick={discard}>
            Discard
          </button>
          <button class="krate-button krate-button-primary" type="button" disabled={!dirty() || busy()} onClick={save}>
            Save settings
          </button>
        </div>
      </div>
    </main>
  );
}
