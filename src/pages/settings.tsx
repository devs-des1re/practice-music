import { createSignal, createEffect, createMemo, onMount } from "@krate/runtime";
import { openFile, openFolder, saveFile } from "@krate/app/dialog";
import { LowLatencyDevices } from "../../api/audio.go";
import { Engine, GetSettings, RestartEngine, SaveSettings } from "../../api/host.go";
import { ExportSettings, ImportSettings } from "../../api/transfer.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Toggle } from "../components/ui/toggle";
import { Notice } from "../components/ui/notice";
import { Readout } from "../components/ui/readout";
import { StatusDot } from "../components/ui/status-dot";
import { LiveText } from "../components/ui/live-text";
import { Topbar } from "../components/blocks/topbar";
import { applyScale } from "../lib/appearance";
import { applyPrefs } from "../lib/prefs";
import { DOWNLOAD_CHOICES, FALLBACK_PREFERENCES } from "../lib/prefs-model";
import { NumberInput } from "../components/ui/number-input";
import { emptyDevices, loadDevices } from "../lib/devices";
import { emptyEngine } from "../lib/engine";
import type { AppSettings, DeviceList, EngineStatus, Preferences } from "../lib/types";
import { bufferLatencyMs, formatRate, formatRates, stateLabel, stateTone } from "../lib/format";
import { logger } from "../lib/logger";
import { askConfirm } from "../lib/modal";
import { ModalHost } from "../components/blocks/modal-host";
import { ContextHost } from "../components/blocks/context-host";
import { TooltipHost } from "../components/ui/tooltip";

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
const SCALE_CHOICES = [80, 90, 100, 110, 125, 150];

const GLASS_CHOICES = [
  { value: "full", label: "Full" },
  { value: "subtle", label: "Subtle" },
  { value: "off", label: "Off, solid surfaces" },
];

const CORNER_CHOICES = [
  { value: "rounded", label: "Rounded" },
  { value: "slight", label: "Slightly rounded" },
  { value: "square", label: "Square" },
];

const TOOLTIP_DELAYS = [
  { value: "200", label: "Short" },
  { value: "450", label: "Normal" },
  { value: "800", label: "Long" },
  { value: "1200", label: "Very long" },
];

const PEAK_HOLDS = [
  { value: "0", label: "No peak mark" },
  { value: "600", label: "0.6 seconds" },
  { value: "1200", label: "1.2 seconds" },
  { value: "2500", label: "2.5 seconds" },
  { value: "5000", label: "5 seconds" },
];

const FADER_STEPS = [
  { value: "0.1", label: "0.1 dB, fine" },
  { value: "0.5", label: "0.5 dB" },
  { value: "1", label: "1 dB" },
];

const SNAP_CHOICES = [
  { value: "beat", label: "Snap to beats" },
  { value: "bar", label: "Snap to bars" },
  { value: "off", label: "No snapping" },
];

const SORT_CHOICES = [
  { value: "added", label: "Newest first" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "duration", label: "Length" },
];

const DOWNLOAD_DEFAULTS = [{ value: "last", label: "The one used last" }].concat(DOWNLOAD_CHOICES);
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
  const [draft, setDraft] = createSignal<AppSettings | null>(null);
  const [notice, setNotice] = createSignal("");
  const [error, setError] = createSignal("");
  const [section, setSection] = createSignal("audio");
  const [stateText, setStateText] = createSignal("Connecting");
  createEffect(() => {
    setStateText(stateLabel(engine().state));
  });
  const [transferInfo, setTransferInfo] = createSignal("");
  const [transferNotes, setTransferNotes] = createSignal("");

  const saving = { running: false, again: false };

  function show(next: AppSettings) {
    setDraft(clone(next));
    applyScale(next.appearance.uiScale);
    applyPrefs(next.preferences);
  }

  async function reload() {
    const doc = await GetSettings();
    show(doc.settings);
    setNotice(doc.notice);
  }

  onMount(() => {
    reload().catch((e) => {
      logger.error("could not read settings", e);
      setError(describe(e));
    });
  });

  async function persist() {
    if (saving.running) {
      saving.again = true;
      return;
    }
    saving.running = true;
    setError("");
    try {
      do {
        saving.again = false;
        const doc = await SaveSettings(draft() as AppSettings);
        setNotice("");
        if (!saving.again) show(doc.settings);
      } while (saving.again);
    } catch (e) {
      logger.error("settings were not saved", e);
      setError("That change was not saved. " + describe(e));
      await reload().catch((again) => logger.error("could not read settings", again));
    } finally {
      saving.running = false;
    }
  }

  function edit(change: (s: AppSettings) => void) {
    if (!draft()) return;
    const next = clone(draft() as AppSettings);
    change(next);
    setDraft(next);
    void persist();
  }

  function prefer(change: (p: Preferences) => void) {
    edit((s) => change(s.preferences));
  }

  async function resetPreferences() {
    const yes = await askConfirm({
      title: "Reset preferences",
      message: "Put appearance, mixer, player, metronome, library and download preferences back to their defaults? Audio devices and library folders are not changed.",
      confirmLabel: "Reset preferences",
      danger: true,
    });
    if (!yes) return;
    edit((s) => {
      s.preferences = { ...(FALLBACK_PREFERENCES as Preferences) };
      s.appearance.uiScale = 100;
    });
  }

  function pick(direction: string, selected: string, emptyLabel = "System default") {
    const host = draft()?.audio.host || "";
    const all = deviceList().devices.filter((d) => d.direction === direction && (host === "" || d.host === host));
    const options = [{ value: "", label: emptyLabel }].concat(
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
  const monitorOptions = createMemo(() => pick("output", draft()?.audio.monitorDevice || "", "Same as amp output"));
  const inputOptions = createMemo(() => pick("input", draft()?.audio.inputDevice || "", "None, no input channels"));

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

  async function removeFolder(folder: string, index: number) {
    const yes = await askConfirm({ title: "Remove library folder", message: "Stop watching " + folder + "? The files stay on disk.", confirmLabel: "Remove folder", danger: true });
    if (yes) edit((s) => s.library.folders.splice(index, 1));
  }

  async function addFolder() {
    try {
      const chosen = await openFolder({ title: "Choose a library folder" });
      if (chosen && chosen.length > 0) edit((s) => s.library.folders.push(chosen[0]));
    } catch (e) {
      logger.error("folder dialog failed", e);
      setError(describe(e));
    }
  }

  async function exportAll() {
    setError("");
    setTransferInfo("");
    setTransferNotes("");
    try {
      const target = await saveFile({
        title: "Export settings",
        name: "practicemusic-settings.json",
        filters: [{ name: "PracticeMusic settings", patterns: ["*.json"] }],
      });
      if (!target) return;
      const res = await ExportSettings(target);
      setTransferInfo("Exported settings, mixer, metronome and " + res.scenes + " scene" + (res.scenes === 1 ? "" : "s") + " to " + res.path + ".");
    } catch (e) {
      logger.error("export failed", e);
      setError(describe(e));
    }
  }

  async function importAll() {
    setError("");
    setTransferInfo("");
    setTransferNotes("");
    try {
      const files = await openFile({
        title: "Import settings",
        filters: [{ name: "PracticeMusic settings", patterns: ["*.json"] }],
      });
      if (!files || files.length === 0) return;
      const res = await ImportSettings(files[0]);
      await reload();
      setTransferInfo("Imported settings, mixer, metronome and " + res.scenes + " scene" + (res.scenes === 1 ? "" : "s") + ".");
      setTransferNotes(res.notes.join(" "));
    } catch (e) {
      logger.error("import failed", e);
      setError(describe(e));
    }
  }

  return (
    <div class="screen">
      <ModalHost />
      <ContextHost />
      <TooltipHost />
      <Topbar />
      <div class="viewport">
    <main class="page settings-page">
      <header class="page-head">
        <h1 class="page-title">
          <Icon name="lucide:settings" />
          Settings
        </h1>
        <div class="actions">
          <Link class="krate-button krate-button-secondary" href="/latency">
            <Icon name="lucide:timer" />
            Latency tools
          </Link>
        </div>
      </header>

      <div showIf={!!notice()}>
        <Notice tone="warn" title="Settings were reset" text={notice()} />
      </div>
      <div showIf={!!error()}>
        <Notice tone="bad" text={error()} />
      </div>
      <div showIf={!!devicesError()}>
        <Notice tone="warn" title="Device list unavailable" text={devicesError()} />
      </div>
      <div showIf={engine().state !== "running"}>
        <Notice tone="warn" text="The audio engine is not running. Device lists fill in once it is up, and saved choices are kept." />
      </div>

      <p class="empty" showIf={!draft() && !error()}>
        Loading settings
      </p>

      <div class="fill settings-ws" showIf={!!draft()}>
        <aside class="rail" data-hue="mixer" aria-label="Settings sections">
          <button class="rail-item" type="button" data-active={section() === "audio" ? "true" : "false"} onClick={() => setSection("audio")}>
            <span class="rail-label">
              <Icon name="lucide:monitor-speaker" />
              Audio
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "engine" ? "true" : "false"} onClick={() => setSection("engine")}>
            <span class="rail-label">
              <Icon name="lucide:cpu" />
              Engine
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "library" ? "true" : "false"} onClick={() => setSection("library")}>
            <span class="rail-label">
              <Icon name="lucide:folder" />
              Library
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "appearance" ? "true" : "false"} onClick={() => setSection("appearance")}>
            <span class="rail-label">
              <Icon name="lucide:sliders-horizontal" />
              Appearance
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "mixer" ? "true" : "false"} onClick={() => setSection("mixer")}>
            <span class="rail-label">
              <Icon name="lucide:sliders-vertical" />
              Mixer
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "player" ? "true" : "false"} onClick={() => setSection("player")}>
            <span class="rail-label">
              <Icon name="lucide:audio-waveform" />
              Player
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "metronome" ? "true" : "false"} onClick={() => setSection("metronome")}>
            <span class="rail-label">
              <Icon name="lucide:metronome" />
              Metronome
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "downloads" ? "true" : "false"} onClick={() => setSection("downloads")}>
            <span class="rail-label">
              <Icon name="lucide:download" />
              Downloads
            </span>
          </button>
          <button class="rail-item" type="button" data-active={section() === "backup" ? "true" : "false"} onClick={() => setSection("backup")}>
            <span class="rail-label">
              <Icon name="lucide:save" />
              Backup
            </span>
          </button>
        </aside>
        <div class="col">
          <div class="pane" showIf={section() === "audio"}>
            <Panel hue="mixer">
              <PanelHead title="Audio">
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={devicesLoading()} onClick={rescan}>
              <Icon name="lucide:refresh-cw" />
              Rescan
            </button>
          </PanelHead>
            <div class="panel-body form-grid">
          <Field label="Driver" htmlFor="audio-host" hint="Choose ASIO, JACK or PipeWire for the lowest latency.">
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
            hint="Headphones or a second output for the monitor mix."
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
            hint="Your kit or audio interface. It feeds the mixer input strips."
            warning={missing("input", draft()?.audio.inputDevice || "")}
          >
            <Select
              id="audio-input"
              value={draft()?.audio.inputDevice || ""}
              options={inputOptions()}
              onChange={(v) => edit((s) => (s.audio.inputDevice = v))}
            />
          </Field>
          <div class="field-row span-2">
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
          <p class="field-hint span-2">{bufferHint()}</p>
          </div>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "engine"}>
            <Panel>
              <PanelHead title="Audio engine">
                <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => RestartEngine()}>
                  <Icon name="lucide:rotate-cw" />
                  Restart
                </button>
              </PanelHead>
              <div class="panel-body fixed">
                <div class="status-line">
                  <StatusDot tone={stateTone(engine().state)} label={stateText()} />
                  <LiveText class="state-text" text={stateText()} />
                </div>
                <div class="readout-grid">
                  <Readout label="Version" value={engine().engineVersion || "-"} />
                  <Readout label="Protocol" value={engine().protocol ? "v" + engine().protocol : "-"} />
                  <Readout label="Process" value={engine().pid ? String(engine().pid) : "-"} />
                  <Readout label="Restarts" value={String(engine().restarts || 0)} />
                </div>
                <div showIf={!!engine().lastError}>
                  <Notice tone={engine().state === "failed" ? "bad" : "warn"} title="Last engine error" text={engine().lastError || ""} />
                </div>
              </div>
              <div class="scroll" showIf={devicesLoaded() && deviceList().devices.length > 0}>
                <table class="device-table">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Driver</th>
                      <th>Direction</th>
                      <th>Channels</th>
                      <th>Sample rates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deviceList().devices.map((d) => (
                      <tr key={d.id + d.direction}>
                        <td>
                          <div class="device-name">
                            <span>{d.name}</span>
                            <span class="device-id">{d.id}</span>
                          </div>
                        </td>
                        <td class="num">{d.host}</td>
                        <td>
                          <span class="tag">{d.direction}</span>
                          {d.isDefault && <span class="tag" data-tone="accent">default</span>}
                        </td>
                        <td class="num">{d.maxChannels}</td>
                        <td class="num rates">{formatRates(d.sampleRates)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "library"}>
            <Panel hue="library">
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
                    class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
                    type="button"
                    aria-label={"Remove " + f}
                    onClick={() => removeFolder(f, i)}
                  >
                    <Icon name="lucide:x" />
                  </button>
                </div>
              ))}
            </div>
            <p class="empty" showIf={(draft()?.library.folders.length ?? 1) === 0}>
              No library folder yet.
            </p>
            <Toggle
              id="library-normalize"
              label="Normalise loudness on import"
              hint="Applies as songs are added."
              checked={!!draft()?.library.normalizeOnImport}
              onChange={(v) => edit((s) => (s.library.normalizeOnImport = v))}
            />
            <Toggle
              id="library-tool-updates"
              label="Update yt-dlp automatically"
              hint="Only for the copy PracticeMusic manages."
              checked={!draft()?.library.disableToolUpdates}
              onChange={(v) => edit((s) => (s.library.disableToolUpdates = !v))}
            />
              <Field label="Sort songs by" htmlFor="pref-sort" hint="The order the library opens in.">
                <Select id="pref-sort" value={(draft()?.preferences.librarySort ?? FALLBACK_PREFERENCES.librarySort)} options={SORT_CHOICES} onChange={(v) => prefer((p) => (p.librarySort = v))} />
              </Field>
              <Toggle id="pref-artwork" label="Show artwork" hint="Thumbnails beside song titles." checked={(draft()?.preferences.artwork ?? FALLBACK_PREFERENCES.artwork)} onChange={(v) => prefer((p) => (p.artwork = v))} />
              <Toggle id="pref-play-on-load" label="Play a song when it loads" hint="Starts playback after you load a song from the library." checked={(draft()?.preferences.playOnLoad ?? FALLBACK_PREFERENCES.playOnLoad)} onChange={(v) => prefer((p) => (p.playOnLoad = v))} />
            </PanelBody>
          </Panel>
          </div>

          <div class="pane" showIf={section() === "appearance"}>
            <Panel hue="player">
              <PanelHead title="Appearance" />
            <PanelBody>
            <Field label="Interface size" htmlFor="ui-scale">
              <Select
                id="ui-scale"
                value={String(draft()?.appearance.uiScale || 100)}
                options={SCALE_CHOICES.map((p) => ({ value: String(p), label: p + "%" }))}
                onChange={(v) => edit((s) => (s.appearance.uiScale = Number(v)))}
              />
            </Field>
              <Field label="Glass effect" htmlFor="pref-glass" hint="Translucent surfaces with a soft sheen. Off can help on slower computers.">
                <Select id="pref-glass" value={(draft()?.preferences.glass ?? FALLBACK_PREFERENCES.glass)} options={GLASS_CHOICES} onChange={(v) => prefer((p) => (p.glass = v))} />
              </Field>
              <Field label="Corners" htmlFor="pref-corners" hint="Applies to buttons, fields, menus and popups.">
                <Select id="pref-corners" value={(draft()?.preferences.corners ?? FALLBACK_PREFERENCES.corners)} options={CORNER_CHOICES} onChange={(v) => prefer((p) => (p.corners = v))} />
              </Field>
              <Toggle id="pref-tooltips" label="Show tooltips" hint="Short help when the pointer rests on a control." checked={(draft()?.preferences.tooltips ?? FALLBACK_PREFERENCES.tooltips)} onChange={(v) => prefer((p) => (p.tooltips = v))} />
              <Field label="Tooltip delay" htmlFor="pref-tooltip-delay">
                <Select id="pref-tooltip-delay" value={String((draft()?.preferences.tooltipDelayMs ?? FALLBACK_PREFERENCES.tooltipDelayMs))} options={TOOLTIP_DELAYS} onChange={(v) => prefer((p) => (p.tooltipDelayMs = Number(v)))} />
              </Field>
            </PanelBody>
          </Panel>
          </div>

          <div class="pane" showIf={section() === "mixer"}>
            <Panel>
              <PanelHead title="Mixer" />
              <PanelBody>
              <Field label="Peak mark hold" htmlFor="pref-peak-hold" hint="How long the highest level stays marked on each channel.">
                <Select id="pref-peak-hold" value={String((draft()?.preferences.peakHoldMs ?? FALLBACK_PREFERENCES.peakHoldMs))} options={PEAK_HOLDS} onChange={(v) => prefer((p) => (p.peakHoldMs = Number(v)))} />
              </Field>
              <Field label="Fader step" htmlFor="pref-fader-step" hint="The smallest change when you drag a fader or use the arrow keys on it.">
                <Select id="pref-fader-step" value={String((draft()?.preferences.faderStepDb ?? FALLBACK_PREFERENCES.faderStepDb))} options={FADER_STEPS} onChange={(v) => prefer((p) => (p.faderStepDb = Number(v)))} />
              </Field>
              <Toggle id="pref-reduction" label="Show compressor and limiter reduction" hint="A thin yellow bar appears beside a channel while its level is being reduced." checked={(draft()?.preferences.reductionBars ?? FALLBACK_PREFERENCES.reductionBars)} onChange={(v) => prefer((p) => (p.reductionBars = v))} />
              </PanelBody>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "player"}>
            <Panel>
              <PanelHead title="Player" />
              <PanelBody>
              <Field label="Default snapping" htmlFor="pref-snap" hint="How loop points snap when you drag on the timeline.">
                <Select id="pref-snap" value={(draft()?.preferences.defaultSnap ?? FALLBACK_PREFERENCES.defaultSnap)} options={SNAP_CHOICES} onChange={(v) => prefer((p) => (p.defaultSnap = v))} />
              </Field>
              <Toggle id="pref-grid" label="Show the beat grid" hint="Beat and bar lines on the waveform. Snapping still works when hidden." checked={(draft()?.preferences.beatGrid ?? FALLBACK_PREFERENCES.beatGrid)} onChange={(v) => prefer((p) => (p.beatGrid = v))} />
              <Field label="Skip with arrow keys (seconds)" htmlFor="pref-seek" hint="1 to 60.">
                <NumberInput id="pref-seek" class="krate-input" label="Skip with arrow keys (seconds)" value={(draft()?.preferences.seekSeconds ?? FALLBACK_PREFERENCES.seekSeconds)} min={1} max={60} decimals={0} onCommit={(v) => prefer((p) => (p.seekSeconds = v))} />
              </Field>
              <Field label="Skip with Shift and arrow keys (seconds)" htmlFor="pref-seek-large" hint="1 to 300.">
                <NumberInput id="pref-seek-large" class="krate-input" label="Skip with Shift and arrow keys (seconds)" value={(draft()?.preferences.seekLargeSeconds ?? FALLBACK_PREFERENCES.seekLargeSeconds)} min={1} max={300} decimals={0} onCommit={(v) => prefer((p) => (p.seekLargeSeconds = v))} />
              </Field>
              <Field label="Speed step (percent)" htmlFor="pref-speed-step" hint="Used by the minus and equals keys. 1 to 25.">
                <NumberInput id="pref-speed-step" class="krate-input" label="Speed step (percent)" value={(draft()?.preferences.speedStep ?? FALLBACK_PREFERENCES.speedStep)} min={1} max={25} decimals={0} onCommit={(v) => prefer((p) => (p.speedStep = v))} />
              </Field>
              <Field label="Previous restarts the song after (seconds)" htmlFor="pref-restart" hint="Before this point, Previous goes to the song before. 0 to 30.">
                <NumberInput id="pref-restart" class="krate-input" label="Previous restarts the song after (seconds)" value={(draft()?.preferences.restartAfterSeconds ?? FALLBACK_PREFERENCES.restartAfterSeconds)} min={0} max={30} decimals={0} onCommit={(v) => prefer((p) => (p.restartAfterSeconds = v))} />
              </Field>
              </PanelBody>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "metronome"}>
            <Panel>
              <PanelHead title="Metronome" />
              <PanelBody>
              <Field label="Tempo step (BPM)" htmlFor="pref-tempo-step" hint="Used by the plus and minus buttons and the Up and Down keys. 0.1 to 10.">
                <NumberInput id="pref-tempo-step" class="krate-input" label="Tempo step (BPM)" value={(draft()?.preferences.tempoStep ?? FALLBACK_PREFERENCES.tempoStep)} min={0.1} max={10} decimals={1} onCommit={(v) => prefer((p) => (p.tempoStep = v))} />
              </Field>
              <Field label="Larger tempo step with Shift (BPM)" htmlFor="pref-tempo-large" hint="0.1 to 50.">
                <NumberInput id="pref-tempo-large" class="krate-input" label="Larger tempo step with Shift (BPM)" value={(draft()?.preferences.tempoStepLarge ?? FALLBACK_PREFERENCES.tempoStepLarge)} min={0.1} max={50} decimals={1} onCommit={(v) => prefer((p) => (p.tempoStepLarge = v))} />
              </Field>
              </PanelBody>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "downloads"}>
            <Panel>
              <PanelHead title="Downloads" />
              <PanelBody>
              <Field label="Default format and quality" htmlFor="pref-download" hint="What a new download starts with.">
                <Select id="pref-download" value={(draft()?.preferences.downloadChoice ?? FALLBACK_PREFERENCES.downloadChoice)} options={DOWNLOAD_DEFAULTS} onChange={(v) => prefer((p) => (p.downloadChoice = v))} />
              </Field>
              </PanelBody>
            </Panel>
          </div>

          <div class="pane" showIf={section() === "backup"}>
            <Panel hue="browser">
              <PanelHead title="Backup" />
            <PanelBody>
              <div class="detail-actions">
                <button class="krate-button krate-button-secondary" type="button" onClick={exportAll}>
                  <Icon name="lucide:download" />
                  Export settings
                </button>
                <button class="krate-button krate-button-secondary" type="button" onClick={importAll}>
                  <Icon name="lucide:upload" />
                  Import settings
                </button>
                <button class="krate-button krate-button-destructive" type="button" onClick={resetPreferences}>
                  <Icon name="lucide:rotate-ccw" />
                  Reset preferences
                </button>
              </div>
              <div showIf={!!transferInfo()}>
                <Notice tone="ok" text={transferInfo()} />
              </div>
              <div showIf={!!transferNotes()}>
                <Notice tone="warn" title="Check these" text={transferNotes()} />
              </div>
            </PanelBody>
          </Panel>
          </div>
        </div>
      </div>

    </main>
      </div>
    </div>
  );
}
