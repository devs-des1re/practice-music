export const LANE_WIDTH = 20;
const BAR = 10;
const BAR_X = 5;
const REDUCTION_X = 17;
const REDUCTION_WIDTH = 2;
const CORNER = 3;
const PEAK_HEIGHT = 3;
const CLIP_HEIGHT = 4;
const VISIBLE_PEAK = 0.01;

export interface LaneView {
  level: number;
  hold: number;
  greenTop: number;
  yellowTop: number;
  unity: number;
  clip: boolean;
  reduction: number;
  pad: number;
}

export function zoneColor(fraction: number, view: LaneView, token: (name: string) => string): string {
  if (fraction > view.yellowTop) return token("--color-meter-red");
  if (fraction > view.greenTop) return token("--color-meter-amber");
  return token("--color-meter-green");
}

export function drawLane(ctx: CanvasRenderingContext2D, height: number, view: LaneView, token: (name: string) => string) {
  const top = view.pad;
  const span = height - top * 2;
  ctx.clearRect(0, 0, LANE_WIDTH, height);
  if (span <= 0) return;
  const yOf = (fraction: number) => top + span * (1 - fraction);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(BAR_X, top, BAR, span, CORNER);
  ctx.fillStyle = token("--color-meter-off");
  ctx.fill();
  ctx.clip();
  const zones = [
    { from: 0, to: view.greenTop, color: "--color-meter-green" },
    { from: view.greenTop, to: view.yellowTop, color: "--color-meter-amber" },
    { from: view.yellowTop, to: 1, color: "--color-meter-red" },
  ];
  for (const zone of zones) {
    const upto = Math.min(view.level, zone.to);
    if (upto <= zone.from) continue;
    ctx.fillStyle = token(zone.color);
    ctx.fillRect(BAR_X, yOf(upto), BAR, span * (upto - zone.from));
  }
  if (view.hold > VISIBLE_PEAK) {
    ctx.fillStyle = zoneColor(view.hold, view, token);
    ctx.fillRect(BAR_X, yOf(view.hold) - 1, BAR, PEAK_HEIGHT);
  }
  ctx.restore();

  ctx.strokeStyle = token("--color-border-strong");
  ctx.beginPath();
  ctx.roundRect(BAR_X - 0.5, top - 0.5, BAR + 1, span + 1, CORNER);
  ctx.stroke();
  ctx.fillStyle = token("--color-text-dim");
  ctx.fillRect(0, Math.round(yOf(view.unity)), BAR_X - 1, 1);
  if (view.clip) {
    ctx.fillStyle = token("--color-meter-red");
    ctx.fillRect(BAR_X, Math.max(0, top - CLIP_HEIGHT - 2), BAR, CLIP_HEIGHT);
  }
  if (view.reduction > 0) {
    ctx.fillStyle = token("--color-meter-amber");
    ctx.fillRect(REDUCTION_X, top, REDUCTION_WIDTH, span * Math.min(1, view.reduction));
  }
}
