export const LANE_WIDTH = 14;
const BAR = 10;
const REDUCTION_X = 12;
const REDUCTION_WIDTH = 2;
const CORNER = 3;
const PEAK_HEIGHT = 2;
const CLIP_HEIGHT = 4;
const VISIBLE_PEAK = 0.01;

export interface LaneView {
  level: number;
  hold: number;
  clip: boolean;
  reduction: number;
}

export function zoneColor(fraction: number, token: (name: string) => string): string {
  if (fraction > 0.95) return token("--color-meter-red");
  if (fraction > 0.8) return token("--color-meter-amber");
  return token("--color-meter-green");
}

export function drawLane(
  ctx: CanvasRenderingContext2D,
  height: number,
  view: LaneView,
  token: (name: string) => string,
) {
  const top = 1;
  const span = height - top * 2;
  ctx.clearRect(0, 0, LANE_WIDTH, height);
  if (span <= 0) return;
  const yOf = (fraction: number) => top + span * (1 - fraction);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0.5, top - 0.5, BAR, span + 1, CORNER);
  ctx.fillStyle = token("--color-meter-off");
  ctx.fill();
  ctx.clip();
  if (view.level > 0) {
    const gradient = ctx.createLinearGradient(0, top + span, 0, top);
    gradient.addColorStop(0, token("--color-meter-green"));
    gradient.addColorStop(0.6, token("--color-meter-green"));
    gradient.addColorStop(0.8, token("--color-meter-amber"));
    gradient.addColorStop(0.96, token("--color-meter-red"));
    gradient.addColorStop(1, token("--color-meter-red"));
    const level = Math.min(1, view.level);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, yOf(level), BAR + 1, span * level);
  }
  if (view.hold > VISIBLE_PEAK) {
    ctx.fillStyle = zoneColor(view.hold, token);
    ctx.fillRect(0, Math.min(yOf(view.hold), top + span - PEAK_HEIGHT), BAR + 1, PEAK_HEIGHT);
  }
  if (view.clip) {
    ctx.fillStyle = token("--color-meter-red");
    ctx.fillRect(0, top, BAR + 1, CLIP_HEIGHT);
  }
  ctx.restore();

  ctx.strokeStyle = token("--color-border-strong");
  ctx.beginPath();
  ctx.roundRect(0.5, top - 0.5, BAR, span + 1, CORNER);
  ctx.stroke();
  if (view.reduction > 0) {
    ctx.fillStyle = token("--color-meter-amber");
    ctx.fillRect(REDUCTION_X, top, REDUCTION_WIDTH, span * Math.min(1, view.reduction));
  }
}
