export const OFF_DB = -60;
export const METER_FLOOR_DB = -60;

export interface Option {
  value: string;
  label: string;
}

export function formatDb(db: number): string {
  if (db <= OFF_DB) return "off";
  const rounded = Math.round(db * 10) / 10;
  const text = Math.abs(rounded).toFixed(1);
  if (rounded > 0) return "+" + text;
  if (rounded < 0) return "-" + text;
  return "0.0";
}

export function toDb(linear: number): number {
  if (!(linear > 0)) return -90;
  return 20 * Math.log10(linear);
}

export function meterFraction(linear: number): number {
  const db = toDb(linear);
  if (db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

export type MeterTone = "green" | "amber" | "red";

export function meterTone(linear: number): MeterTone {
  const db = toDb(linear);
  if (db >= -3) return "red";
  if (db >= -12) return "amber";
  return "green";
}

export function channelPairs(channels: number): Option[] {
  if (channels <= 1) return [{ value: "0", label: "Output 1 (mono)" }];
  const out: Option[] = [];
  for (let offset = 0; offset + 2 <= Math.min(channels, 64); offset += 2) {
    out.push({ value: String(offset), label: "Outputs " + (offset + 1) + "-" + (offset + 2) });
  }
  return out;
}

export function sourceOptions(channels: number, stereo: boolean): Option[] {
  const count = channels > 0 ? Math.min(channels, 16) : 4;
  const out: Option[] = [];
  for (let i = 0; i < count; i++) {
    if (stereo && i + 1 >= count) break;
    out.push({ value: String(i), label: stereo ? "Inputs " + (i + 1) + "-" + (i + 2) : "Input " + (i + 1) });
  }
  return out.length > 0 ? out : [{ value: "0", label: stereo ? "Inputs 1-2" : "Input 1" }];
}

export function cycleAccent(level: number): number {
  switch (level) {
    case 3:
      return 2;
    case 2:
      return 1;
    case 1:
      return 0;
    default:
      return 3;
  }
}

export function accentLabel(level: number): string {
  switch (level) {
    case 3:
      return "Accent";
    case 2:
      return "Normal";
    case 1:
      return "Soft";
    default:
      return "Silent";
  }
}

export const SUBDIVISIONS: Option[] = [
  { value: "1", label: "None" },
  { value: "2", label: "Eighths" },
  { value: "3", label: "Triplets" },
  { value: "4", label: "Sixteenths" },
  { value: "5", label: "Quintuplets" },
  { value: "6", label: "Sextuplets" },
  { value: "8", label: "Thirty-seconds" },
];

export function polyLabel(poly: number, beats: number): string {
  if (poly <= 0) return "Off";
  return poly + " over " + beats;
}

export function barCaption(bar: number, beat: number, beatsPerBar: number): string {
  return "Bar " + (bar + 1) + ", beat " + (beat + 1) + " of " + beatsPerBar;
}

export function cleanBpm(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return Math.round(Math.min(400, Math.max(20, value)) * 10) / 10;
}

export function stripSummary(gain: number, mute: boolean, solo: boolean): string {
  if (mute) return "muted";
  if (solo) return "solo";
  return formatDb(gain);
}

export const SCALE_FLOOR_DB = -60;
export const SCALE_CEIL_DB = 12;

export function scaleFraction(linear: number): number {
  const db = toDb(linear);
  if (db <= SCALE_FLOOR_DB) return 0;
  if (db >= SCALE_CEIL_DB) return 1;
  return (db - SCALE_FLOOR_DB) / (SCALE_CEIL_DB - SCALE_FLOOR_DB);
}

export function dbFraction(db: number): number {
  return Math.min(1, Math.max(0, (db - SCALE_FLOOR_DB) / (SCALE_CEIL_DB - SCALE_FLOOR_DB)));
}

export function peakText(linear: number): string {
  const db = toDb(linear);
  if (db <= SCALE_FLOOR_DB) return "-inf";
  return formatDb(db);
}
