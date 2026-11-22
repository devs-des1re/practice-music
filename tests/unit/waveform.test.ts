import { test } from "node:test";
import assert from "node:assert/strict";
import { snapTime, gridLines, barAndBeat, formatClock, hitHandle, orderRegion, beatLengthMs } from "../../src/lib/waveform.ts";

const grid = { bpm: 120, offsetMs: 100, beatsPerBar: 4, downbeat: 1 };

test("beat length follows the tempo", () => {
  assert.equal(beatLengthMs(120), 500);
  assert.equal(beatLengthMs(0), 0);
});

test("snapping to beats lands on the grid and clamps to the song", () => {
  assert.equal(snapTime(640, grid, "beat", 60000), 600);
  assert.equal(snapTime(860, grid, "beat", 60000), 1100);
  assert.equal(snapTime(10, grid, "beat", 60000), 100);
  assert.equal(snapTime(59990, grid, "beat", 60000), 60000);
  assert.equal(snapTime(-500, grid, "beat", 60000), 100);
});

test("snapping to bars uses the downbeat", () => {
  assert.equal(snapTime(1500, grid, "bar", 60000), 600);
  assert.equal(snapTime(1700, grid, "bar", 60000), 2600);
  assert.equal(snapTime(3000, grid, "bar", 60000), 2600);
});

test("snap off and a missing grid keep the raw time", () => {
  assert.equal(snapTime(1234, grid, "off", 60000), 1234);
  assert.equal(snapTime(1234, null, "beat", 60000), 1234);
  assert.equal(snapTime(99999, null, "beat", 60000), 60000);
});

test("grid lines mark the bar starts", () => {
  const lines = gridLines(grid, 4100);
  assert.equal(lines[0].ms, 100);
  assert.equal(lines[0].bar, false);
  const bars = lines.filter((l) => l.bar).map((l) => l.ms);
  assert.deepEqual(bars, [600, 2600]);
  assert.ok(lines.every((l) => l.ms >= 0 && l.ms <= 4100));
  assert.deepEqual(gridLines(null, 1000), []);
  assert.ok(gridLines({ ...grid, bpm: 400 }, 3600000, 50).length <= 50);
});

test("bar and beat counting is one based", () => {
  assert.deepEqual(barAndBeat(600, grid), { bar: 1, beat: 1 });
  assert.deepEqual(barAndBeat(1100, grid), { bar: 1, beat: 2 });
  assert.deepEqual(barAndBeat(2600, grid), { bar: 2, beat: 1 });
  assert.deepEqual(barAndBeat(0, { ...grid, downbeat: 0 }), { bar: 0, beat: 4 });
  assert.deepEqual(barAndBeat(1000, null), { bar: 0, beat: 0 });
});

test("the clock shows minutes, seconds and tenths", () => {
  assert.equal(formatClock(0), "0:00.0");
  assert.equal(formatClock(61234), "1:01.2");
  assert.equal(formatClock(-5), "0:00.0");
});

test("handles are only grabbable when the loop is on and near", () => {
  assert.equal(hitHandle(100, 98, 300, true, 8), "start");
  assert.equal(hitHandle(305, 98, 300, true, 8), "end");
  assert.equal(hitHandle(200, 98, 300, true, 8), null);
  assert.equal(hitHandle(100, 98, 300, false, 8), null);
  assert.equal(hitHandle(200, 198, 202, true, 8), "start");
});

test("regions are ordered whichever way they were dragged", () => {
  assert.deepEqual(orderRegion(5, 2), { start: 2, end: 5 });
  assert.deepEqual(orderRegion(2, 5), { start: 2, end: 5 });
});
