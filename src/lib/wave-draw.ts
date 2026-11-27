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

export interface WaveMarker {
  name: string;
  startMs: number;
  endMs: number;
}

export interface WaveRegion {
  start: number;
  end: number;
  on: boolean;
}

export interface GridLine {
  ms: number;
  bar: boolean;
}

export interface WaveView {
  peaks: number[];
  duration: number;
  position: number;
  region: WaveRegion;
  lines: GridLine[];
  markers: WaveMarker[];
}

export interface Flag {
  x0: number;
  x1: number;
  index: number;
}

export const RULER = 22;
export const LANE = 20;
const MIN_TICK_PX = 64;

export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  HEIGHT: number,
  view: WaveView,
  token: (name: string) => string,
): Flag[] {
  const { peaks, duration, position, region: reg } = view;
  const markers = view.markers;
  const lane = markers.length > 0 ? LANE : 0;
  const top = RULER + lane;
  const body = HEIGHT - top;
  const xOf = (ms: number) => (ms / duration) * width;
  ctx.fillStyle = token("--color-surface-inset");
  ctx.fillRect(0, 0, width, HEIGHT);

  if (reg.on) {
    ctx.fillStyle = token("--color-song-soft");
    ctx.fillRect(xOf(reg.start), top, Math.max(1, xOf(reg.end) - xOf(reg.start)), body);
  }

  const lines = view.lines;
  const spacing = lines.length > 1 ? ((lines[1].ms - lines[0].ms) / duration) * width : 0;
  for (const line of lines) {
    if (!line.bar && spacing < 7) continue;
    const x = Math.round(xOf(line.ms)) + 0.5;
    ctx.strokeStyle = line.bar ? token("--color-border-strong") : token("--color-wave-grid");
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }

  const mid = top + body / 2;
  const pairs = Math.floor(peaks.length / 2);
  let peak = 0.0001;
  for (let i = 0; i < peaks.length; i++) peak = Math.max(peak, Math.abs(peaks[i]));
  const scale = (body / 2 - 4) / peak;
  const playedX = xOf(position);
  ctx.fillStyle = token("--color-border");
  ctx.fillRect(0, Math.round(mid), width, 1);
  for (let x = 0; x < width; x++) {
    const bucket = Math.min(pairs - 1, Math.floor((x / width) * pairs));
    const lo = peaks[bucket * 2] * scale;
    const hi = peaks[bucket * 2 + 1] * scale;
    ctx.fillStyle = x < playedX ? token("--color-song") : token("--color-wave-rest");
    const y0 = mid - Math.max(hi, 0.5);
    const y1 = mid - Math.min(lo, -0.5);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }

  ctx.fillStyle = token("--color-surface-raised");
  ctx.fillRect(0, 0, width, RULER);
  ctx.fillStyle = token("--color-border-strong");
  ctx.fillRect(0, RULER - 1, width, 1);
  ctx.font = "11px " + token("--font-mono");
  ctx.textBaseline = "middle";
  const step = rulerStepMs(duration, width, MIN_TICK_PX);
  const minor = step <= 2000 ? 2 : step === 15000 ? 3 : 5;
  for (let ms = 0; ms <= duration; ms += step) {
    const x = Math.round(xOf(ms)) + 0.5;
    ctx.fillStyle = token("--color-text-dim");
    ctx.fillRect(x, RULER - 7, 1, 6);
    if (x + 40 < width) ctx.fillText(rulerLabel(ms), x + 4, 9);
    for (let k = 1; k < minor; k++) {
      const mx = Math.round(xOf(ms + (step * k) / minor)) + 0.5;
      if (mx < width) ctx.fillRect(mx, RULER - 4, 1, 3);
    }
  }

  if (reg.on) {
    const x0 = Math.round(xOf(reg.start));
    const x1 = Math.round(xOf(reg.end));
    ctx.fillStyle = token("--color-song-soft");
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), RULER - 1);
    ctx.fillStyle = token("--color-song");
    ctx.fillRect(x0, RULER - 3, Math.max(2, x1 - x0), 2);
    const label =
      "LOOP " + rulerLabel(reg.start) + " - " + rulerLabel(reg.end) + "  (" + rulerLabel(reg.end - reg.start) + ")";
    if (x1 - x0 > ctx.measureText(label).width + 12) ctx.fillText(label, x0 + 6, 9);
  }

  const flags: Flag[] = [];
  if (lane > 0) {
    ctx.fillStyle = token("--color-surface");
    ctx.fillRect(0, RULER, width, lane);
    ctx.fillStyle = token("--color-border");
    ctx.fillRect(0, RULER + lane - 1, width, 1);
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const x0 = Math.round(xOf(m.startMs));
      const x1 = Math.max(x0 + 28, Math.round(xOf(m.endMs)));
      const active = reg.on && Math.abs(m.startMs - reg.start) < 60 && Math.abs(m.endMs - reg.end) < 60;
      ctx.fillStyle = active ? token("--color-song-soft") : token("--color-surface-raised");
      ctx.fillRect(x0 + 1, RULER + 2, x1 - x0 - 1, lane - 4);
      ctx.fillStyle = active ? token("--color-song") : token("--color-text-dim");
      ctx.fillRect(x0, RULER + 2, 2, lane - 4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 4, RULER, Math.max(0, x1 - x0 - 6), lane);
      ctx.clip();
      ctx.fillStyle = active ? token("--color-song") : token("--color-text-muted");
      ctx.font = "11px " + token("--font-sans");
      ctx.fillText(m.name, x0 + 7, RULER + lane / 2 + 0.5);
      ctx.restore();
      flags.push({ x0, x1, index: i });
    }
  }

  if (reg.on) {
    ctx.fillStyle = token("--color-song");
    for (const ms of [reg.start, reg.end]) {
      const x = Math.round(xOf(ms));
      ctx.fillRect(x - 1, top, 2, body);
      ctx.fillRect(x - 5, top, 11, 9);
      ctx.fillRect(x - 5, HEIGHT - 9, 11, 9);
    }
  }

  const px = Math.round(playedX);
  ctx.fillStyle = token("--color-text");
  ctx.fillRect(px, 0, 1, HEIGHT);
  ctx.beginPath();
  ctx.moveTo(px - 5, 0);
  ctx.lineTo(px + 6, 0);
  ctx.lineTo(px + 0.5, 8);
  ctx.closePath();
  ctx.fill();
  return flags;
}
