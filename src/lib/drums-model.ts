export interface DrumPadShape {
  id: string;
  label: string;
  notes: number[];
  sound: string;
  files: string[];
  gainDb: number;
  pan: number;
  tune: number;
  sensitivity: number;
  choke: number;
}

export interface DrumSettingsShape {
  kit: string;
  threshold: number;
  pedalFollows: boolean;
  pedalThreshold: number;
  pedalReversed: boolean;
  pads: DrumPadShape[];
}

export interface HitShape {
  seq: number;
  kind: string;
  note: number;
  value: number;
}

export interface SoundShape {
  id: string;
  label: string;
}

export interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface HitLine {
  key: string;
  title: string;
  detail: string;
  mapped: boolean;
}

export const KIT_CHOICES: Choice[] = [
  { value: "none", label: "No kit" },
  { value: "muldjord", label: "MuldjordKit, acoustic rock and metal" },
];

export const LEVEL_CHOICES: Choice[] = [0, 25, 50, 60, 75, 100, 125, 150, 200].map((n) => ({
  value: String(n / 100),
  label: n === 0 ? "Off" : n + "%",
}));

export const CURVE_CHOICES: Choice[] = [
  { value: "soft", label: "Light touch: soft hits play louder" },
  { value: "linear", label: "Even: as you play it" },
  { value: "hard", label: "Heavy touch: loud needs a harder hit" },
];

export const CHOKE_CHOICES: Choice[] = [{ value: "0", label: "None" }].concat(
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: "Group " + n })),
);

export const SOUND_PATTERNS = ["*.wav", "*.flac", "*.ogg", "*.mp3", "*.aif", "*.aiff"];

export function levelChoices(current: number): Choice[] {
  if (LEVEL_CHOICES.some((c) => Number(c.value) === current)) return LEVEL_CHOICES;
  return LEVEL_CHOICES.concat([{ value: String(current), label: Math.round(current * 100) + "%" }]).sort(
    (a, b) => Number(a.value) - Number(b.value),
  );
}

export function padForNote(pads: DrumPadShape[], note: number): DrumPadShape | null {
  return pads.find((p) => p.notes.includes(note)) || null;
}

export function padForHit(settings: DrumSettingsShape, note: number, pedal: number): DrumPadShape | null {
  const found = padForNote(settings.pads, note);
  if (!found || !settings.pedalFollows || (found.id !== "hihat_open" && found.id !== "hihat_closed")) return found;
  const pressed = settings.pedalReversed ? 127 - pedal : pedal;
  const wanted = pressed >= settings.pedalThreshold ? "hihat_closed" : "hihat_open";
  return settings.pads.find((p) => p.id === wanted) || found;
}

export function describeHit(settings: DrumSettingsShape, hit: HitShape, pedal: number): HitLine {
  const key = [hit.seq, hit.kind, hit.note, hit.value].join(":");
  if (hit.kind === "pedal") return { key, title: "Hi-hat pedal", detail: "position " + hit.value, mapped: true };
  const pad = padForHit(settings, hit.note, pedal);
  const name = pad ? pad.label : "No pad uses this note";
  if (hit.kind === "grab") return { key, title: name, detail: "note " + hit.note + ", held to stop it", mapped: !!pad };
  const quiet = hit.value < settings.threshold ? ", below the minimum so it is ignored" : "";
  return { key, title: name, detail: "note " + hit.note + ", strength " + hit.value + quiet, mapped: !!pad };
}

export function addHit(list: HitLine[], line: HitLine, limit: number): HitLine[] {
  if (list.length > 0 && list[0].key === line.key) return list;
  const rest = line.title === "Hi-hat pedal" && list.length > 0 && list[0].title === line.title ? list.slice(1) : list;
  return [line].concat(rest).slice(0, limit);
}

export function notesText(notes: number[]): string {
  if (notes.length === 0) return "No MIDI note";
  return (notes.length === 1 ? "Note " : "Notes ") + notes.join(", ");
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function soundSummary(pad: DrumPadShape, sounds: SoundShape[], kit: string, installed: boolean): string {
  if (pad.sound === "none") return "Silent";
  if (pad.sound === "custom") return pad.files.length === 1 ? fileName(pad.files[0]) : pad.files.length + " of your files";
  if (kit === "none") return "No kit chosen";
  if (!installed) return "Kit not downloaded";
  const found = sounds.find((s) => s.id === pad.sound);
  return found ? found.label : "Silent";
}

export function soundChoices(pad: DrumPadShape, sounds: SoundShape[]): Choice[] {
  return [{ value: "none", label: "Silent" } as Choice]
    .concat(sounds.map((s) => ({ value: s.id, label: "Kit: " + s.label })))
    .concat([{ value: "custom", label: pad.files.length > 0 ? "My own files" : "My own files (add some below)", disabled: pad.files.length === 0 }]);
}

export function changePad<T extends DrumSettingsShape>(settings: T, id: string, change: (p: DrumPadShape) => DrumPadShape): T {
  return { ...settings, pads: settings.pads.map((p) => (p.id === id ? change(p) : p)) };
}

export function resetPad<T extends DrumSettingsShape>(settings: T, defaults: DrumSettingsShape, id: string): T {
  const base = defaults.pads.find((p) => p.id === id);
  if (!base) return settings;
  return {
    ...settings,
    pads: settings.pads.map((p) =>
      p.id === id
        ? { ...base, notes: base.notes.slice(), files: [] }
        : { ...p, notes: p.notes.filter((n) => !base.notes.includes(n)) },
    ),
  };
}

export function addFiles<T extends DrumSettingsShape>(settings: T, id: string, files: string[]): T {
  return changePad(settings, id, (p) => {
    const next = Array.from(new Set(p.files.concat(files))).slice(0, 32);
    return { ...p, files: next, sound: next.length > 0 ? "custom" : p.sound };
  });
}

export function removeFile<T extends DrumSettingsShape>(settings: T, defaults: DrumSettingsShape, id: string, file: string): T {
  const fallback = defaults.pads.find((p) => p.id === id)?.sound || "none";
  return changePad(settings, id, (p) => {
    const next = p.files.filter((f) => f !== file);
    return { ...p, files: next, sound: next.length === 0 && p.sound === "custom" ? fallback : p.sound };
  });
}

export function megabytes(bytes: number): string {
  const value = bytes / 1e6;
  return (value > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value))) + " MB";
}

export function percentDone(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, done / total)) * 100);
}

export function kitProgressText(phase: string, done: number, total: number): string {
  if (phase === "downloading") return "Downloading " + megabytes(done) + " of about " + megabytes(total);
  if (phase === "unpacking") return "Checking and unpacking recording " + done + " of " + total;
  if (phase === "removing") return "Removing the kit";
  return "";
}

export function loadText(state: string, done: number, total: number, bytes: number, running: boolean): string {
  if (!running) return "The sounds load when audio is running.";
  if (state === "loading") return "Loading sounds: " + done + " of " + total + " recordings";
  if (state === "ready") return total + " recordings ready, " + megabytes(bytes) + " in memory";
  if (state === "failed") return "The sounds could not be loaded.";
  return "Nothing to load. Choose a kit or add your own files to a pad.";
}

export function listeningInputs<T extends { kind: string; main: number }>(strips: T[]): T[] {
  return strips.filter((s) => s.kind === "input" && s.main > -60);
}

export function portChoices(ports: string[], saved: string): Choice[] {
  const out: Choice[] = [{ value: "", label: "None" }].concat(ports.map((p) => ({ value: p, label: p })));
  if (saved && !ports.includes(saved)) out.push({ value: saved, label: saved + " (not connected)" });
  return out;
}
