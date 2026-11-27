import { test } from "node:test";
import assert from "node:assert/strict";
import { faderKeyValue, faderValueAt, snapFader } from "../../src/lib/fader.ts";

test("the top of the travel is the highest level and the bottom the lowest", () => {
  assert.equal(faderValueAt(0, 200, -60, 12, 0.5), 12);
  assert.equal(faderValueAt(200, 200, -60, 12, 0.5), -60);
  assert.equal(faderValueAt(100, 200, -60, 12, 0.5), -24);
});

test("dragging past either end stays inside the range", () => {
  assert.equal(faderValueAt(-80, 200, -60, 12, 0.5), 12);
  assert.equal(faderValueAt(900, 200, -60, 12, 0.5), -60);
  assert.equal(faderValueAt(10, 0, -60, 12, 0.5), -60);
});

test("levels land on the chosen step without rounding noise", () => {
  assert.equal(snapFader(-3.26, -60, 12, 0.5), -3.5);
  assert.equal(snapFader(0.04, -60, 12, 0.1), 0);
  assert.equal(snapFader(-12.3, -60, 12, 1), -12);
});

test("keys move the fader up and down", () => {
  assert.equal(faderKeyValue("ArrowUp", 0, -60, 12, 0.5), 0.5);
  assert.equal(faderKeyValue("ArrowDown", 0, -60, 12, 0.5), -0.5);
  assert.equal(faderKeyValue("PageUp", 9, -60, 12, 0.5), 12);
  assert.equal(faderKeyValue("PageDown", 0, -60, 12, 0.5), -6);
  assert.equal(faderKeyValue("Home", 0, -60, 12, 0.5), 12);
  assert.equal(faderKeyValue("End", 0, -60, 12, 0.5), -60);
  assert.equal(faderKeyValue("m", 0, -60, 12, 0.5), null);
});
