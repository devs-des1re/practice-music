import { test } from "node:test";
import assert from "node:assert/strict";
import { drawLane, zoneColor, type LaneView } from "../../src/lib/meter-draw.ts";

const base: LaneView = { level: 0, hold: 0, clip: false, reduction: 0 };
const token = (name: string) => name;

function record(view: LaneView) {
  const fills: { color: unknown; x: number; y: number; w: number; h: number }[] = [];
  const stops: [number, string][] = [];
  const line: number[] = [];
  const gradient = { addColorStop: (at: number, color: string) => stops.push([at, color]) };
  let color: unknown = "";
  const ctx = {
    set fillStyle(value: unknown) {
      color = value;
    },
    set strokeStyle(_value: string) {},
    createLinearGradient(...points: number[]) {
      line.push(...points);
      return gradient;
    },
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    clip() {},
    fillRect(x: number, y: number, w: number, h: number) {
      assert.ok([x, y, w, h].every(Number.isFinite), "every bar needs real numbers");
      fills.push({ color, x, y, w, h });
    },
  } as unknown as CanvasRenderingContext2D;
  drawLane(ctx, 202, view, token);
  return { fills, stops, line, gradient };
}

test("a full level fills the bar from the bottom to the very top", () => {
  const { fills, gradient } = record({ ...base, level: 1 });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].color, gradient);
  assert.equal(fills[0].y, 1);
  assert.equal(fills[0].h, 200);
});

test("half a level fills the lower half", () => {
  const { fills } = record({ ...base, level: 0.5 });
  assert.equal(fills[0].y, 101);
  assert.equal(fills[0].h, 100);
});

test("the gradient runs from green at the bottom through yellow to red at the top", () => {
  const { stops, line } = record({ ...base, level: 0.3 });
  assert.deepEqual(line, [0, 201, 0, 1]);
  assert.equal(stops[0][1], "--color-meter-green");
  assert.ok(stops.some(([, name]) => name === "--color-meter-amber"));
  assert.deepEqual(stops.at(-1), [1, "--color-meter-red"]);
  assert.ok(stops.every(([at], i) => i === 0 || at > stops[i - 1][0]));
});

test("the held peak takes the colour of the height it reached", () => {
  assert.equal(zoneColor(0.5, token), "--color-meter-green");
  assert.equal(zoneColor(0.85, token), "--color-meter-amber");
  assert.equal(zoneColor(0.98, token), "--color-meter-red");
  const peak = record({ ...base, hold: 0.85 }).fills.find((f) => f.h === 2);
  assert.equal(peak?.color, "--color-meter-amber");
});

test("a silent channel draws no level, peak or second bar", () => {
  assert.equal(record(base).fills.length, 0);
});

test("gain reduction and clipping appear only when they happen", () => {
  const { fills } = record({ ...base, clip: true, reduction: 0.5 });
  assert.ok(fills.some((f) => f.x === 12 && f.color === "--color-meter-amber" && f.h === 100));
  assert.ok(fills.some((f) => f.color === "--color-meter-red" && f.y === 1 && f.h === 4));
});
