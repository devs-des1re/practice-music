import { test } from "node:test";
import assert from "node:assert/strict";
import { clampNumber, parseLevel } from "../../src/lib/numbers.ts";

test("a typed number is limited only once it is complete", () => {
  assert.equal(clampNumber("140", 20, 400, 1), 140);
  assert.equal(clampNumber("7", 20, 400, 1), 20);
  assert.equal(clampNumber("950", 20, 400, 1), 400);
});

test("decimals are rounded and a comma is accepted", () => {
  assert.equal(clampNumber(" 97,46 ", 20, 400, 1), 97.5);
  assert.equal(clampNumber("3.6", 1, 32, 0), 4);
});

test("empty or unreadable text is reported instead of guessed", () => {
  assert.equal(clampNumber("", 20, 400, 1), null);
  assert.equal(clampNumber("fast", 20, 400, 1), null);
});

test("a typed volume accepts its unit and the word off", () => {
  assert.equal(parseLevel("-6 dB", -60, 12, 1), -6);
  assert.equal(parseLevel("+3.5db", -60, 12, 1), 3.5);
  assert.equal(parseLevel("off", -60, 12, 1), -60);
  assert.equal(parseLevel("-inf", -60, 12, 1), -60);
  assert.equal(parseLevel(" 75% ", 0, 120, 0), 75);
  assert.equal(parseLevel("500", 0, 120, 0), 120);
  assert.equal(parseLevel("loud", -60, 12, 1), null);
  assert.equal(parseLevel("", -60, 12, 1), null);
});
