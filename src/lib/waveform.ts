export interface GridInfo {
  bpm: number;
  offsetMs: number;
  beatsPerBar: number;
  downbeat: number;
}

export type SnapMode = "beat" | "bar" | "off";

export function beatLengthMs(bpm: number): number {
  return bpm > 0 ? 60000 / bpm : 0;
}

export function snapTime(ms: number, grid: GridInfo | null, mode: SnapMode, durationMs: number): number {
  const clamped = Math.min(Math.max(ms, 0), durationMs);
  if (!grid || mode === "off" || grid.bpm <= 0) return clamped;
  const beat = beatLengthMs(grid.bpm);
  const unit = mode === "bar" ? beat * grid.beatsPerBar : beat;
  const origin = mode === "bar" ? grid.offsetMs + grid.downbeat * beat : grid.offsetMs;
  const steps = Math.round((clamped - origin) / unit);
  const snapped = origin + steps * unit;
  return Math.min(Math.max(snapped, 0), durationMs);
}

export interface GridLine {
  ms: number;
  bar: boolean;
}

export function gridLines(grid: GridInfo | null, durationMs: number, maxLines = 2000): GridLine[] {
  if (!grid || grid.bpm <= 0 || durationMs <= 0) return [];
  const beat = beatLengthMs(grid.bpm);
  const lines: GridLine[] = [];
  const first = Math.ceil((0 - grid.offsetMs) / beat);
  for (let k = first; lines.length < maxLines; k++) {
    const ms = grid.offsetMs + k * beat;
    if (ms > durationMs) break;
    if (ms < 0) continue;
    const inBar = (((k - grid.downbeat) % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar;
    lines.push({ ms, bar: inBar === 0 });
  }
  return lines;
}

export function barAndBeat(ms: number, grid: GridInfo | null): { bar: number; beat: number } {
  if (!grid || grid.bpm <= 0) return { bar: 0, beat: 0 };
  const beat = beatLengthMs(grid.bpm);
  const k = Math.floor((ms - grid.offsetMs) / beat);
  const fromBarStart = k - grid.downbeat;
  const bar = Math.floor(fromBarStart / grid.beatsPerBar);
  const inBar = ((fromBarStart % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar;
  return { bar: bar + 1, beat: inBar + 1 };
}

export function formatClock(ms: number): string {
  const safe = Math.max(0, ms);
  const total = Math.floor(safe / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const tenth = Math.floor((safe % 1000) / 100);
  return `${m}:${s.toString().padStart(2, "0")}.${tenth}`;
}

export type Handle = "start" | "end" | null;

export function hitHandle(x: number, startX: number, endX: number, loopOn: boolean, tolerance: number): Handle {
  if (!loopOn) return null;
  const dStart = Math.abs(x - startX);
  const dEnd = Math.abs(x - endX);
  if (dStart > tolerance && dEnd > tolerance) return null;
  return dStart <= dEnd ? "start" : "end";
}

export function orderRegion(a: number, b: number): { start: number; end: number } {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

const RULER_STEPS_MS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];

export function rulerStepMs(durationMs: number, widthPx: number, minSpacingPx: number): number {
  if (durationMs <= 0 || widthPx <= 0) return RULER_STEPS_MS[0];
  const perPx = durationMs / widthPx;
  for (const step of RULER_STEPS_MS) {
    if (step / perPx >= minSpacingPx) return step;
  }
  return RULER_STEPS_MS[RULER_STEPS_MS.length - 1];
}

export function rulerLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}
