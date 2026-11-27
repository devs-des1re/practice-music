import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDb,
  toDb,
  meterFraction,
  scaleFraction,
  dbFraction,
  peakText,
  meterTone,
  channelPairs,
  sourceOptions,
  cycleAccent,
  accentLabel,
  polyLabel,
  barCaption,
  cleanBpm,
  stripSummary,
} from "../../src/lib/mixer.ts";

test("decibel readouts show the sign and treat the bottom of the fader as off", () => {
  assert.equal(formatDb(-60), "off");
  assert.equal(formatDb(-75), "off");
  assert.equal(formatDb(0), "0.0");
  assert.equal(formatDb(3), "+3.0");
  assert.equal(formatDb(-6.26), "-6.3");
  assert.equal(formatDb(-0.04), "0.0");
});

test("linear to decibels", () => {
  assert.ok(Math.abs(toDb(1)) < 1e-9);
  assert.ok(Math.abs(toDb(0.5) + 6.0206) < 1e-3);
  assert.equal(toDb(0), -90);
  assert.equal(toDb(-1), -90);
});

test("meter fraction spans minus sixty to zero decibels", () => {
  assert.equal(meterFraction(0), 0);
  assert.equal(meterFraction(0.0005), 0);
  assert.equal(meterFraction(1), 1);
  assert.equal(meterFraction(3), 1);
  assert.ok(Math.abs(meterFraction(0.1) - 40 / 60) < 1e-9);
});

test("meters go green then amber then red", () => {
  assert.equal(meterTone(0.05), "green");
  assert.equal(meterTone(0.3), "amber");
  assert.equal(meterTone(0.8), "red");
  assert.equal(meterTone(1), "red");
});

test("output pairs follow the device channel count", () => {
  assert.deepEqual(
    channelPairs(1).map((o) => o.value),
    ["0"],
  );
  assert.deepEqual(
    channelPairs(2).map((o) => o.value),
    ["0"],
  );
  assert.deepEqual(
    channelPairs(6).map((o) => o.value),
    ["0", "2", "4"],
  );
  assert.equal(channelPairs(4)[1].label, "Outputs 3-4");
  assert.deepEqual(
    channelPairs(5).map((o) => o.value),
    ["0", "2"],
  );
  assert.equal(channelPairs(0).length, 1);
});

test("input sources are single channels or adjacent pairs", () => {
  assert.equal(sourceOptions(8, false).length, 8);
  assert.equal(sourceOptions(8, true).length, 7);
  assert.equal(sourceOptions(2, true)[0].label, "Inputs 1-2");
  assert.equal(sourceOptions(0, false).length, 4);
  assert.equal(sourceOptions(40, false).length, 16);
  assert.equal(sourceOptions(1, true).length, 1);
});

test("accent levels cycle through all four and come back", () => {
  let level = 3;
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(level);
    level = cycleAccent(level);
  }
  assert.deepEqual(seen, [3, 2, 1, 0, 3]);
  assert.equal(accentLabel(3), "Accent");
  assert.equal(accentLabel(0), "Silent");
});

test("polyrhythm and bar captions are readable", () => {
  assert.equal(polyLabel(0, 4), "Off");
  assert.equal(polyLabel(3, 4), "3 over 4");
  assert.equal(barCaption(0, 0, 4), "Bar 1, beat 1 of 4");
  assert.equal(barCaption(6, 2, 7), "Bar 7, beat 3 of 7");
});

test("tempo input is clamped and rounded", () => {
  assert.equal(cleanBpm(5), 20);
  assert.equal(cleanBpm(999), 400);
  assert.equal(cleanBpm(97.26), 97.3);
  assert.equal(cleanBpm(Number.NaN), 120);
});

test("strip summaries prefer mute and solo over the level", () => {
  assert.equal(stripSummary(-3, true, true), "muted");
  assert.equal(stripSummary(-3, false, true), "solo");
  assert.equal(stripSummary(-3, false, false), "-3.0");
});

test("the shared scale puts zero decibels at five sixths of the way up", () => {
  assert.equal(scaleFraction(0), 0);
  assert.equal(scaleFraction(1), dbFraction(0));
  assert.ok(Math.abs(dbFraction(0) - 60 / 72) < 1e-12);
  assert.equal(dbFraction(12), 1);
  assert.equal(dbFraction(-80), 0);
  assert.equal(scaleFraction(100), 1);
});

test("peak readouts show minus infinity until there is a signal", () => {
  assert.equal(peakText(0), "-inf");
  assert.equal(peakText(1), "0.0");
  assert.equal(peakText(2), "+6.0");
});

test("the peak colour zone follows the meter colours", async () => {
  const { peakZone } = await import("../../src/lib/mixer.ts");
  assert.equal(peakZone(0), "none");
  assert.equal(peakZone(0.000001), "none");
  assert.equal(peakZone(0.1), "low");
  assert.equal(peakZone(0.5), "high");
  assert.equal(peakZone(0.9), "top");
});

test("listen switches the send to the speakers off and back to what it was", async () => {
  const { isListening, listenSend } = await import("../../src/lib/mixer.ts");
  assert.equal(isListening(-60), false);
  assert.equal(isListening(-12), true);
  assert.equal(listenSend(-60, undefined), 0);
  assert.equal(listenSend(-6, undefined), -60);
  assert.equal(listenSend(-60, -6), -6);
  assert.equal(listenSend(-60, -60), 0);
});

test("the drums channel sits after the click and before the inputs", async () => {
  const { inDisplayOrder } = await import("../../src/lib/mixer.ts");
  const kinds = ["song", "click", "input", "input", "input", "input", "drums"];
  const strips = kinds.map((kind, index) => ({ kind, index }));
  assert.deepEqual(
    inDisplayOrder(strips).map((s) => s.index),
    [0, 1, 6, 2, 3, 4, 5],
  );
  assert.equal(strips[2].index, 2);
});
