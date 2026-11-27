import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { openFile } from "@krate/app/dialog";
import {
  DrumStream,
  MidiStream,
  DrumsGet,
  DrumsSave,
  DrumsReset,
  DrumsLearn,
  DrumsScan,
  DrumsPlay,
  DrumsKitDownload,
  DrumsKitCancel,
  DrumsKitRemove,
  DrumStatusNow,
} from "../../api/drumkit.go";
import { AudioStream } from "../../api/audio.go";
import { GetMixer, SetMixerStrip } from "../../api/session.go";
import { Topbar } from "../components/blocks/topbar";
import { ServiceNotice } from "../components/blocks/service-notice";
import { ModalHost } from "../components/blocks/modal-host";
import { ContextHost } from "../components/blocks/context-host";
import { TooltipHost } from "../components/ui/tooltip";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Toggle } from "../components/ui/toggle";
import { Notice } from "../components/ui/notice";
import { StatusDot } from "../components/ui/status-dot";
import { LiveText } from "../components/ui/live-text";
import { ParamRow } from "../components/ui/param-row";
import { NumberInput } from "../components/ui/number-input";
import { askConfirm } from "../lib/modal";
import { DIVIDER, openContextMenu } from "../lib/context-menu";
import { formatDb } from "../lib/mixer";
import { handleError, logFailure } from "../lib/service";
import {
  CHOKE_CHOICES,
  CURVE_CHOICES,
  KIT_CHOICES,
  SOUND_PATTERNS,
  addFiles,
  addHit,
  changePad,
  describeHit,
  fileName,
  kitProgressText,
  levelChoices,
  listeningInputs,
  loadText,
  megabytes,
  notesText,
  padForHit,
  percentDone,
  portChoices,
  removeFile,
  resetPad,
  soundChoices,
  soundSummary,
  type Choice,
  type DrumPadShape,
  type HitLine,
} from "../lib/drums-model";
import type { DrumInfo, DrumSettings, DrumState, MidiFrame, MixerStrip } from "../lib/types";

const DRUM_STRIP = 6;
const HIT_LINES = 8;
const FLASH_MS = 150;

const noDrumStatus = {
  ports: [],
  open: "",
  portError: "",
  kit: { installed: false, phase: "", done: 0, total: 0, error: "" },
  load: { state: "idle", done: 0, total: 0, bytes: 0, error: "" },
} as unknown as DrumState;

const noDrumPad = {
  id: "",
  label: "Pad",
  notes: [],
  sound: "none",
  files: [],
  gainDb: 0,
  pan: 0,
  tune: 0,
  sensitivity: 1,
  choke: 0,
} as DrumPadShape;

const noDrumStrip = { index: DRUM_STRIP, gain: 0, mute: false } as unknown as MixerStrip;

const noDrumView = {
  banner: "",
  learn: "",
  midi: "No MIDI input chosen",
  download: "Download",
  kitProgress: "",
  kitPercent: "0",
  credit: "",
  load: "",
  loadPercent: "0",
  level: "0.0",
  mute: "Mute the Drums channel",
  pedal: "",
  volume: "0 dB",
  pan: "",
  tune: "",
  sensitivity: "100%",
  padLabel: "Pad",
  padSound: "none",
  padNotes: [] as number[],
  padFiles: [] as string[],
  padGain: 0,
  padPan: 0,
  padTune: 0,
  padSensitivity: 1,
  padChoke: "0",
  stripGain: 0,
  stripMuted: false,
  ports: [] as Choice[],
  kits: [] as Choice[],
  curves: [] as Choice[],
  rooms: [] as Choice[],
  overheads: [] as Choice[],
  sounds: [] as Choice[],
  chokes: [] as Choice[],
};

function drumCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.02) return "As recorded";
  return (pan < 0 ? "Left " : "Right ") + Math.round(Math.abs(pan) * 100);
}

function tuneLabel(tune: number): string {
  if (tune === 0) return "Original";
  return (tune > 0 ? "+" : "") + tune + " st";
}

export default function DrumsPage() {
  const [drumInfo, setDrumInfo] = createSignal<DrumInfo | null>(null);
  const [drumDraft, setDrumDraft] = createSignal<DrumSettings | null>(null);
  const [drumStatus, setDrumStatus] = createSignal<DrumState>(noDrumStatus);
  const [drumStrips, setDrumStrips] = createSignal<MixerStrip[]>([]);
  const [drumRunning, setDrumRunning] = createSignal(false);
  const [drumSelected, setDrumSelected] = createSignal("snare");
  const [drumLearning, setDrumLearning] = createSignal("");
  const [drumHits, setDrumHits] = createSignal<HitLine[]>([]);
  const [drumFlashes, setDrumFlashes] = createSignal<Record<string, boolean>>({});
  const [drumPedal, setDrumPedal] = createSignal(0);
  const [drumError, setDrumError] = createSignal("");
  const [drumView, setDrumView] = createSignal(noDrumView);

  const drumSaving: { run: Promise<void> | null; again: boolean } = { run: null, again: false };
  const stripSaving = { running: false, again: false };
  const flashTimers: Record<string, number> = {};
  const heard = { key: "" };

  createEffect(() => {
    const info = drumInfo();
    const settings = drumDraft();
    const status = drumStatus();
    const wanted = drumSelected();
    const chosen = settings?.pads.find((p) => p.id === wanted) || noDrumPad;
    const strip = drumStrips()[DRUM_STRIP] || noDrumStrip;
    const extra = listeningInputs(drumStrips()).map((s) => s.name);
    const hearing = !!settings?.enabled && status.load.state === "ready" && extra.length > 0;
    const room = settings?.room ?? 0.6;
    const overheads = settings?.overheads ?? 1;
    setDrumView({
      banner: hearing ? "You also hear " + extra.join(" and ") + " straight from the line input, on top of the sampled drums." : "",
      learn: "Hit the drum you want to use for " + chosen.label + ".",
      midi: status.portError || (status.open ? "Listening to " + status.open : "No MIDI input chosen"),
      download: "Download, " + megabytes(info?.downloadBytes || 0),
      kitProgress: kitProgressText(status.kit.phase, status.kit.done, status.kit.total),
      kitPercent: String(percentDone(status.kit.done, status.kit.total)),
      credit: info ? info.kitCredit + " Licence: " + info.kitLicense + "." : "",
      load: loadText(status.load.state, status.load.done, status.load.total, status.load.bytes, drumRunning()),
      loadPercent: String(percentDone(status.load.done, status.load.total)),
      level: formatDb(strip.gain),
      mute: strip.mute ? "Unmute the Drums channel" : "Mute the Drums channel",
      pedal: "Pedal position now: " + drumPedal(),
      volume: (chosen.gainDb > 0 ? "+" : "") + chosen.gainDb + " dB",
      pan: panLabel(chosen.pan),
      tune: tuneLabel(chosen.tune),
      sensitivity: Math.round(chosen.sensitivity * 100) + "%",
      padLabel: chosen.label,
      padSound: chosen.sound,
      padNotes: chosen.notes.slice(),
      padFiles: chosen.files.slice(),
      padGain: chosen.gainDb,
      padPan: chosen.pan,
      padTune: chosen.tune,
      padSensitivity: chosen.sensitivity,
      padChoke: String(chosen.choke),
      stripGain: strip.gain,
      stripMuted: strip.mute,
      ports: portChoices(status.ports || [], settings?.port || ""),
      kits: KIT_CHOICES,
      curves: CURVE_CHOICES,
      rooms: levelChoices(room),
      overheads: levelChoices(overheads),
      sounds: soundChoices(chosen, info?.sounds || []),
      chokes: CHOKE_CHOICES,
    });
  });

  const drumFail = (what: string) => (e: unknown) => {
    logFailure(what, e);
    handleError(e, setDrumError);
  };

  async function loadDrumPage() {
    const found = await DrumsGet();
    setDrumInfo(found);
    setDrumDraft(drumCopy(found.settings));
    setDrumStatus(await DrumsScan());
    setDrumStrips((await GetMixer()).strips);
  }

  onMount(() => {
    loadDrumPage().catch(drumFail("the drum settings could not be read"));
    DrumStatusNow().catch((e) => logFailure("drum status", e));
    onCleanup(() => {
      for (const timer of Object.values(flashTimers)) window.clearTimeout(timer);
    });
  });

  createEffect(() => {
    const next = DrumStream();
    if (next && next.ports) setDrumStatus(next);
  });

  createEffect(() => {
    const next = AudioStream();
    if (next) setDrumRunning(!!next.running);
  });

  createEffect(() => {
    const frame = MidiStream();
    if (!frame || !frame.seq) return;
    const key = [frame.seq, frame.kind, frame.note, frame.value].join(":");
    if (key === heard.key) return;
    heard.key = key;
    window.setTimeout(() => takeHit(frame), 0);
  });

  function flashPad(id: string) {
    window.clearTimeout(flashTimers[id]);
    setDrumFlashes({ ...drumFlashes(), [id]: true });
    flashTimers[id] = window.setTimeout(() => setDrumFlashes({ ...drumFlashes(), [id]: false }), FLASH_MS);
  }

  function takeHit(frame: MidiFrame) {
    const settings = drumDraft();
    if (!settings) return;
    if (frame.kind === "pedal") setDrumPedal(frame.value);
    setDrumHits(addHit(drumHits(), describeHit(settings, frame, drumPedal()), HIT_LINES));
    if (frame.kind !== "hit") return;
    const target = padForHit(settings, frame.note, drumPedal());
    if (target && frame.value >= settings.threshold) flashPad(target.id);
    const waiting = drumLearning();
    if (waiting) {
      setDrumLearning("");
      learnNote(waiting, frame.note).catch(drumFail("the pad did not learn the note"));
    }
  }

  async function learnNote(id: string, note: number) {
    if (drumSaving.run) await drumSaving.run;
    setDrumDraft(drumCopy(await DrumsLearn(id, note)));
    flashPad(id);
  }

  async function writeDrums() {
    try {
      do {
        drumSaving.again = false;
        const saved = await DrumsSave(drumDraft() as DrumSettings);
        if (!drumSaving.again) setDrumDraft(drumCopy(saved));
      } while (drumSaving.again);
      setDrumError("");
    } catch (e) {
      drumFail("drum settings were not saved")(e);
      const found = await DrumsGet();
      setDrumDraft(drumCopy(found.settings));
    }
  }

  function persistDrums() {
    if (drumSaving.run) {
      drumSaving.again = true;
      return;
    }
    drumSaving.run = writeDrums()
      .catch(drumFail("drum settings could not be read back"))
      .finally(() => {
        drumSaving.run = null;
        if (drumSaving.again) persistDrums();
      });
  }

  function editDrums(change: (s: DrumSettings) => DrumSettings) {
    const settings = drumDraft();
    if (!settings) return;
    setDrumDraft(change(drumCopy(settings)));
    persistDrums();
  }

  function editPad(change: (p: DrumPadShape) => DrumPadShape) {
    const id = drumSelected();
    editDrums((s) => changePad(s, id, change));
  }

  async function writeDrumStrip() {
    if (stripSaving.running) {
      stripSaving.again = true;
      return;
    }
    stripSaving.running = true;
    try {
      do {
        stripSaving.again = false;
        await SetMixerStrip(DRUM_STRIP, drumStrips()[DRUM_STRIP]);
      } while (stripSaving.again);
    } catch (e) {
      drumFail("the drum level was not applied")(e);
    } finally {
      stripSaving.running = false;
    }
  }

  function editDrumStrip(change: (s: MixerStrip) => MixerStrip) {
    const strips = drumStrips().slice();
    if (!strips[DRUM_STRIP]) return;
    strips[DRUM_STRIP] = change(strips[DRUM_STRIP]);
    setDrumStrips(strips);
    void writeDrumStrip();
  }

  async function stopListening() {
    try {
      for (const strip of listeningInputs(drumStrips())) await SetMixerStrip(strip.index, { ...strip, main: -60 });
      setDrumStrips((await GetMixer()).strips);
    } catch (e) {
      drumFail("the line input could not be muted")(e);
    }
  }

  function playPad(id: string, strength: number) {
    DrumsPlay(id, strength)
      .then(() => flashPad(id))
      .catch(drumFail("the pad did not play"));
  }

  async function chooseFiles(id: string) {
    try {
      const label = drumDraft()?.pads.find((p) => p.id === id)?.label || "this pad";
      const files = await openFile({
        title: "Choose sounds for " + label,
        multiple: true,
        filters: [{ name: "Sound files", patterns: SOUND_PATTERNS }],
      });
      if (files && files.length > 0) editDrums((s) => addFiles(s, id, files));
    } catch (e) {
      drumFail("the file dialog failed")(e);
    }
  }

  async function dropFile(file: string) {
    const id = drumSelected();
    const yes = await askConfirm({
      title: "Remove sound",
      message: "Take " + fileName(file) + " off this pad? The file stays on your computer.",
      confirmLabel: "Remove sound",
      danger: true,
    });
    const defaults = drumInfo()?.defaults;
    if (yes && defaults) editDrums((s) => removeFile(s, defaults, id, file));
  }

  async function restorePad(id: string) {
    const label = drumDraft()?.pads.find((p) => p.id === id)?.label || "this pad";
    const yes = await askConfirm({
      title: "Reset " + label,
      message: "Put its sound, notes, level, pan, pitch, sensitivity and choke back to the defaults? Your files stay on your computer.",
      confirmLabel: "Reset pad",
      danger: true,
    });
    const defaults = drumInfo()?.defaults;
    if (yes && defaults) editDrums((s) => resetPad(s, defaults, id));
  }

  async function restoreAll() {
    const yes = await askConfirm({
      title: "Reset drum settings",
      message: "Put every pad and playing setting back to the defaults? The MIDI input and kit choice are kept.",
      confirmLabel: "Reset drum settings",
      danger: true,
    });
    if (!yes) return;
    try {
      if (drumSaving.run) await drumSaving.run;
      setDrumDraft(drumCopy(await DrumsReset()));
    } catch (e) {
      drumFail("the drum settings were not reset")(e);
    }
  }

  async function downloadKit() {
    const info = drumInfo();
    if (!info) return;
    const yes = await askConfirm({
      title: "Download " + info.kitName,
      message:
        "This downloads about " +
        megabytes(info.downloadBytes) +
        " from github.com/sfzinstruments and keeps " +
        megabytes(info.installedBytes) +
        " of it on this computer. " +
        info.kitCredit +
        " Licence: " +
        info.kitLicense +
        ".",
      confirmLabel: "Download",
    });
    if (yes) DrumsKitDownload().catch(drumFail("the download did not start"));
  }

  async function removeKit() {
    const yes = await askConfirm({
      title: "Remove the downloaded kit",
      message: "Delete the downloaded recordings from this computer? Your pad settings and your own files are kept.",
      confirmLabel: "Remove kit",
      danger: true,
    });
    if (!yes) return;
    try {
      if (drumSaving.run) await drumSaving.run;
      setDrumDraft(drumCopy(await DrumsKitRemove()));
    } catch (e) {
      drumFail("the kit was not removed")(e);
    }
  }

  function padMenu(e: MouseEvent, id: string) {
    setDrumSelected(id);
    openContextMenu(e, [
      { label: "Play", onSelect: () => playPad(id, 110) },
      { label: "Play softly", onSelect: () => playPad(id, 45) },
      DIVIDER,
      { label: "Learn from a hit", onSelect: () => setDrumLearning(id) },
      { label: "Add sound files", onSelect: () => void chooseFiles(id) },
      DIVIDER,
      { label: "Reset pad", onSelect: () => void restorePad(id) },
    ]);
  }

  return (
    <div class="screen">
      <ModalHost />
      <ContextHost />
      <TooltipHost />
      <Topbar />
      <ServiceNotice />
      <div class="viewport">
        <main class="page drum-page">
          <header class="page-head">
            <h1 class="page-title">
              <Icon name="lucide:drum" />
              Drums
            </h1>
            <div class="actions">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={restoreAll}>
                <Icon name="lucide:rotate-ccw" />
                Reset drum settings
              </button>
            </div>
          </header>

          <div showIf={!!drumInfo()?.notice}>
            <Notice tone="warn" title="Drum settings" text={drumInfo()?.notice || ""} />
          </div>
          <div showIf={!!drumError()}>
            <Notice tone="bad" text={drumError()} />
          </div>
          <div class="drum-banner" showIf={!!drumView().banner}>
            <Notice tone="warn" text={drumView().banner} />
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={stopListening}>
              <Icon name="lucide:volume-x" />
              Stop listening to it
            </button>
          </div>

          <p class="empty" showIf={!drumDraft() && !drumError()}>
            Loading drum settings
          </p>

          <div class="fill drum-ws" showIf={!!drumDraft()}>
            <div class="col scroll-col drum-setup">
              <Panel>
                <header class="panel-head">
                  <h2 class="panel-title">MIDI input</h2>
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Rescan MIDI devices" data-tip="Look for MIDI devices again" onClick={() => DrumsScan().then(setDrumStatus).catch(drumFail("the MIDI scan failed"))}>
                    <Icon name="lucide:refresh-cw" />
                  </button>
                </header>
                <PanelBody>
                  <Field label="Device" htmlFor="drum-port" hint="Your drum module over USB or MIDI.">
                    <Select
                      id="drum-port"
                      value={drumDraft()?.port || ""}
                      options={drumView().ports}
                      onChange={(v) => editDrums((s) => ({ ...s, port: v }))}
                    />
                  </Field>
                  <div class="status-line">
                    <StatusDot tone={drumStatus().portError ? "warn" : drumStatus().open ? "ok" : "idle"} label="MIDI state" />
                    <LiveText class="drum-midi-state" text={drumView().midi} />
                  </div>
                  <p class="field-hint">Plug your headphones or speakers into this computer to hear these sounds, and turn the drum module's own volume down.</p>
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHead title="Drum kit" />
                <PanelBody>
                  <Field label="Kit" htmlFor="drum-kit">
                    <Select id="drum-kit" value={drumDraft()?.kit || "none"} options={drumView().kits} onChange={(v) => editDrums((s) => ({ ...s, kit: v }))} />
                  </Field>
                  <div class="drum-kit-box" showIf={drumDraft()?.kit === "muldjord"}>
                    <div class="drum-kit-box" showIf={!drumStatus().kit.installed && !drumStatus().kit.phase}>
                      <p class="field-hint">The recordings are not on this computer yet. Nothing is downloaded until you choose to.</p>
                      <button class="krate-button krate-button-primary krate-button-sm" type="button" onClick={downloadKit}>
                        <Icon name="lucide:download" />
                        {drumView().download}
                      </button>
                    </div>
                    <div class="drum-kit-box" showIf={!!drumStatus().kit.phase}>
                      <LiveText class="field-hint" text={drumView().kitProgress} />
                      <progress class="drum-progress" max="100" aria-label="Kit progress" value={drumView().kitPercent} />
                      <button class="krate-button krate-button-secondary krate-button-sm" type="button" showIf={drumStatus().kit.phase !== "removing"} onClick={() => DrumsKitCancel()}>
                        <Icon name="lucide:x" />
                        Cancel
                      </button>
                    </div>
                    <div showIf={!!drumStatus().kit.error}>
                      <Notice tone="bad" text={drumStatus().kit.error} />
                    </div>
                    <div class="drum-kit-box" showIf={drumStatus().kit.installed && !drumStatus().kit.phase}>
                      <Field label="Room microphones" htmlFor="drum-room" hint="More sounds bigger and further away.">
                        <Select id="drum-room" value={String(drumDraft()?.room ?? 0.6)} options={drumView().rooms} onChange={(v) => editDrums((s) => ({ ...s, room: Number(v) }))} />
                      </Field>
                      <Field label="Overhead microphones" htmlFor="drum-overheads" hint="Most of the cymbal sound comes from these.">
                        <Select id="drum-overheads" value={String(drumDraft()?.overheads ?? 1)} options={drumView().overheads} onChange={(v) => editDrums((s) => ({ ...s, overheads: Number(v) }))} />
                      </Field>
                      <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={removeKit}>
                        <Icon name="lucide:trash-2" />
                        Remove downloaded kit
                      </button>
                    </div>
                    <p class="field-hint">{drumView().credit}</p>
                  </div>

                  <LiveText class="field-hint" text={drumView().load} />
                  <progress class="drum-progress" max="100" aria-label="Loading sounds" showIf={drumStatus().load.state === "loading"} value={drumView().loadPercent} />
                  <div showIf={!!drumStatus().load.error}>
                    <Notice tone="warn" text={drumStatus().load.error} />
                  </div>

                  <ParamRow
                    label="Level"
                    ariaLabel="Drums channel level"
                    min={-60}
                    max={12}
                    step={0.5}
                    value={drumView().stripGain}
                    text={drumView().level}
                    onInput={(v) => editDrumStrip((s) => ({ ...s, gain: v }))}
                    onReset={() => editDrumStrip((s) => ({ ...s, gain: 0 }))}
                  />
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" aria-pressed={drumView().stripMuted ? "true" : "false"} onClick={() => editDrumStrip((s) => ({ ...s, mute: !s.mute }))}>
                    <Icon name="lucide:volume-x" />
                    <LiveText class="button-text" text={drumView().mute} />
                  </button>
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHead title="Playing" />
                <PanelBody>
                  <Toggle id="drum-enabled" label="Play drum sounds" hint="Off frees the memory the sounds use. Hits still show in the monitor." checked={!!drumDraft()?.enabled} onChange={(v) => editDrums((s) => ({ ...s, enabled: v }))} />
                  <Field label="Velocity curve" htmlFor="drum-curve">
                    <Select id="drum-curve" value={drumDraft()?.curve || "linear"} options={drumView().curves} onChange={(v) => editDrums((s) => ({ ...s, curve: v }))} />
                  </Field>
                  <Field label="Ignore hits weaker than" htmlFor="drum-threshold" hint="1 to 60. Raise it if pads trigger by themselves.">
                    <NumberInput id="drum-threshold" class="krate-input" label="Weakest hit that plays" value={drumDraft()?.threshold ?? 5} min={1} max={60} decimals={0} onCommit={(v) => editDrums((s) => ({ ...s, threshold: v }))} />
                  </Field>
                  <Toggle id="drum-pedal" label="Hi-hat follows the pedal" hint="For kits that send one hi-hat note and the pedal position separately." checked={!!drumDraft()?.pedalFollows} onChange={(v) => editDrums((s) => ({ ...s, pedalFollows: v }))} />
                  <div class="drum-kit-box" showIf={!!drumDraft()?.pedalFollows}>
                    <Field label="Closed from pedal position" htmlFor="drum-pedal-threshold" hint="1 to 127.">
                      <NumberInput id="drum-pedal-threshold" class="krate-input" label="Pedal position that counts as closed" value={drumDraft()?.pedalThreshold ?? 80} min={1} max={127} decimals={0} onCommit={(v) => editDrums((s) => ({ ...s, pedalThreshold: v }))} />
                    </Field>
                    <Toggle id="drum-pedal-reversed" label="Reverse the pedal" hint="Turn on if open and closed are swapped." checked={!!drumDraft()?.pedalReversed} onChange={(v) => editDrums((s) => ({ ...s, pedalReversed: v }))} />
                    <LiveText class="field-hint" text={drumView().pedal} />
                  </div>
                </PanelBody>
              </Panel>
            </div>

            <div class="col scroll-col drum-stage">
              <Panel>
                <PanelHead title="Pads" />
                <PanelBody>
                  <div class="drum-learn" showIf={!!drumLearning()}>
                    <Notice tone="info" text={drumView().learn} />
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => setDrumLearning("")}>
                      Cancel
                    </button>
                  </div>
                  <div class="pad-grid">
                    {(drumDraft()?.pads || []).map((p) => (
                      <button
                        class="drum-pad"
                        type="button"
                        key={p.id}
                        data-selected={drumSelected() === p.id ? "true" : "false"}
                        data-hit={drumFlashes()[p.id] ? "true" : "false"}
                        aria-pressed={drumSelected() === p.id ? "true" : "false"}
                        onClick={() => {
                          setDrumSelected(p.id);
                          setDrumLearning("");
                        }}
                        onDoubleClick={() => playPad(p.id, 110)}
                        onContextMenu={(e: MouseEvent) => padMenu(e, p.id)}
                      >
                        <span class="drum-pad-name">{p.label}</span>
                        <span class="drum-pad-sound">{soundSummary(p, drumInfo()?.sounds || [], drumDraft()?.kit || "none", drumStatus().kit.installed)}</span>
                        <span class="drum-pad-notes">{notesText(p.notes)}</span>
                      </button>
                    ))}
                  </div>
                  <p class="field-hint">Click a pad to edit it. Double-click to hear it, or right-click for more.</p>
                </PanelBody>
              </Panel>

              <Panel>
                <header class="panel-head">
                  <h2 class="panel-title">Hit monitor</h2>
                  <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => setDrumHits([])}>
                    Clear
                  </button>
                </header>
                <PanelBody>
                  <p class="empty" showIf={drumHits().length === 0}>
                    Nothing yet. Choose your MIDI input, then hit a pad.
                  </p>
                  <ul class="hit-list">
                    {drumHits().map((h) => (
                      <li class="hit-row" key={h.key} data-mapped={h.mapped ? "true" : "false"}>
                        <span class="hit-name">{h.title}</span>
                        <span class="hit-detail">{h.detail}</span>
                      </li>
                    ))}
                  </ul>
                </PanelBody>
              </Panel>
            </div>

            <div class="col scroll-col drum-editor">
              <Panel>
                <header class="panel-head">
                  <h2 class="panel-title">{drumView().padLabel}</h2>
                  <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => restorePad(drumSelected())}>
                    Reset pad
                  </button>
                </header>
                <PanelBody>
                  <div class="drum-actions">
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => playPad(drumSelected(), 110)}>
                      <Icon name="lucide:play" />
                      Play
                    </button>
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" data-tip="Hit a drum to give its note to this pad" onClick={() => setDrumLearning(drumSelected())}>
                      <Icon name="lucide:scan-line" />
                      Learn
                    </button>
                  </div>

                  <div class="field">
                    <span class="field-label">MIDI notes</span>
                    <div class="note-list">
                      {drumView().padNotes.map((n) => (
                        <button class="krate-button krate-button-secondary krate-button-sm note-button" type="button" key={n} aria-label={"Remove note " + n} onClick={() => editPad((p) => ({ ...p, notes: p.notes.filter((x) => x !== n) }))}>
                          {n}
                          <Icon name="lucide:x" />
                        </button>
                      ))}
                    </div>
                    <p class="field-hint" showIf={drumView().padNotes.length === 0}>
                      No note yet. Press Learn and hit a drum.
                    </p>
                  </div>

                  <Field label="Sound" htmlFor="pad-sound">
                    <Select id="pad-sound" value={drumView().padSound} options={drumView().sounds} onChange={(v) => editPad((p) => ({ ...p, sound: v }))} />
                  </Field>

                  <div class="field">
                    <span class="field-label">Your own sounds</span>
                    <div class="folder-list" showIf={drumView().padFiles.length > 0}>
                      {drumView().padFiles.map((f) => (
                        <div class="folder-row" key={f}>
                          <span class="folder-path" title={f}>
                            {fileName(f)}
                          </span>
                          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label={"Remove " + fileName(f)} onClick={() => dropFile(f)}>
                            <Icon name="lucide:x" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => chooseFiles(drumSelected())}>
                      <Icon name="lucide:folder-open" />
                      Add sound files
                    </button>
                    <p class="field-hint">WAV, FLAC, OGG, MP3 or AIFF. Add hits from soft to hard and louder hits play the louder files. Files of similar loudness take turns.</p>
                  </div>

                  <ParamRow label="Volume" ariaLabel="Pad volume" min={-24} max={12} step={0.5} value={drumView().padGain} text={drumView().volume} onInput={(v) => editPad((p) => ({ ...p, gainDb: v }))} onReset={() => editPad((p) => ({ ...p, gainDb: 0 }))} />
                  <ParamRow label="Pan" ariaLabel="Pad pan" min={-1} max={1} step={0.05} value={drumView().padPan} text={drumView().pan} onInput={(v) => editPad((p) => ({ ...p, pan: v }))} onReset={() => editPad((p) => ({ ...p, pan: 0 }))} />
                  <ParamRow label="Pitch" ariaLabel="Pad pitch in semitones" min={-12} max={12} step={0.5} value={drumView().padTune} text={drumView().tune} onInput={(v) => editPad((p) => ({ ...p, tune: v }))} onReset={() => editPad((p) => ({ ...p, tune: 0 }))} />
                  <ParamRow label="Sensitivity" ariaLabel="Pad sensitivity" min={0.25} max={4} step={0.05} value={drumView().padSensitivity} text={drumView().sensitivity} onInput={(v) => editPad((p) => ({ ...p, sensitivity: v }))} onReset={() => editPad((p) => ({ ...p, sensitivity: 1 }))} />

                  <Field label="Choke group" htmlFor="pad-choke" hint="Pads in the same group cut each other off, like an open and a closed hi-hat.">
                    <Select id="pad-choke" value={drumView().padChoke} options={drumView().chokes} onChange={(v) => editPad((p) => ({ ...p, choke: Number(v) }))} />
                  </Field>
                </PanelBody>
              </Panel>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
