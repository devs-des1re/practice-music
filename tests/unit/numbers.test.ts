import { test } from "node:test";
import assert from "node:assert/strict";
import { clampNumber } from "../../src/lib/numbers.ts";

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
