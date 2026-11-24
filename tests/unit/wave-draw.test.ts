import { test } from "node:test";
import assert from "node:assert/strict";
import { drawWaveform, LANE, RULER, type WaveView } from "../../src/lib/wave-draw.ts";

function recorder() {
  const calls: string[] = [];
  const target: Record<string, unknown> = { measureText: () => ({ width: 40 }) };
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      return (...args: unknown[]) => {
        calls.push(key + ":" + args.join(","));
      };
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const peaks = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? -0.5 : 0.5));
const base: WaveView = {
  peaks,
  duration: 120000,
  position: 30000,
  region: { start: 20000, end: 50000, on: true },
  lines: [
    { ms: 0, bar: true },
    { ms: 500, bar: false },
    { ms: 2000, bar: true },
  ],
  markers: [
    { name: "Intro", startMs: 0, endMs: 20000 },
    { name: "Verse", startMs: 20000, endMs: 50000 },
  ],
};

test("every section gets a clickable flag inside the marker lane", () => {
  const { ctx } = recorder();
  const flags = drawWaveform(ctx, 800, 240, base, () => "#000");
  assert.equal(flags.length, 2);
  assert.equal(flags[0].index, 0);
  assert.ok(flags[1].x0 > flags[0].x0);
  assert.ok(flags.every((f) => f.x1 > f.x0));
});

test("without sections there is no marker lane and no flags", () => {
  const { ctx, calls } = recorder();
  const flags = drawWaveform(ctx, 800, 240, { ...base, markers: [] }, () => "#000");
  assert.equal(flags.length, 0);
  assert.ok(calls.some((c) => c.startsWith("fillRect:0," + RULER + ",800")) === false);
  assert.ok(RULER + LANE < 240);
});

test("drawing never throws for a loop that covers the whole song or a missing grid", () => {
  const { ctx } = recorder();
  assert.doesNotThrow(() => drawWaveform(ctx, 300, 120, { ...base, region: { start: 0, end: 120000, on: true }, lines: [] }, () => "#000"));
  assert.doesNotThrow(() => drawWaveform(ctx, 300, 120, { ...base, region: { start: 0, end: 0, on: false } }, () => "#000"));
});
