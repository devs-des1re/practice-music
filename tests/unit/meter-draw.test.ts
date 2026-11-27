import { test } from "node:test";
import assert from "node:assert/strict";
import { drawLane, zoneColor, type LaneView } from "../../src/lib/meter-draw.ts";

const base: LaneView = {
  level: 0,
  hold: 0,
  greenTop: 0.66,
  yellowTop: 0.79,
  unity: 0.83,
  clip: false,
  reduction: 0,
  pad: 10,
};
const token = (name: string) => name;

function record(view: LaneView) {
  const fills: { color: string; x: number; y: number; w: number; h: number }[] = [];
  let color = "";
  const ctx = {
    set fillStyle(value: string) {
      color = value;
    },
    set strokeStyle(_value: string) {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    clip() {},
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ color, x, y, w, h });
    },
  } as unknown as CanvasRenderingContext2D;
  drawLane(ctx, 220, view, token);
  return fills;
}

test("a rising level fills green, then yellow, then red from the bottom of one bar", () => {
  const bars = record({ ...base, level: 0.9 }).filter((f) => f.x === 5 && f.w === 10);
  assert.deepEqual(
    bars.map((f) => f.color),
    ["--color-meter-green", "--color-meter-amber", "--color-meter-red"],
  );
  assert.ok(Math.abs(bars[0].y + bars[0].h - 210) < 1e-9);
  assert.ok(bars[2].y < bars[1].y && bars[1].y < bars[0].y);
});

test("the held peak takes the colour of the zone it reached", () => {
  assert.equal(zoneColor(0.5, base, token), "--color-meter-green");
  assert.equal(zoneColor(0.7, base, token), "--color-meter-amber");
  assert.equal(zoneColor(0.95, base, token), "--color-meter-red");
  const peak = record({ ...base, hold: 0.7 }).find((f) => f.h === 3);
  assert.equal(peak?.color, "--color-meter-amber");
});

test("a silent channel draws no level, peak or second bar", () => {
  const fills = record(base);
  assert.equal(fills.filter((f) => f.x >= 5).length, 0);
});

test("gain reduction and clipping appear only when they happen", () => {
  const fills = record({ ...base, clip: true, reduction: 0.5 });
  assert.ok(fills.some((f) => f.x === 17 && f.color === "--color-meter-amber" && f.h === 100));
  assert.ok(fills.some((f) => f.color === "--color-meter-red" && f.h === 4));
});
