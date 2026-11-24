import { test } from "node:test";
import assert from "node:assert/strict";
import { setQueue, neighbour } from "../../src/lib/queue.ts";

test("neighbours follow the visible song order", () => {
  setQueue([4, 9, 2]);
  assert.equal(neighbour(9, 1), 2);
  assert.equal(neighbour(9, -1), 4);
});

test("there is nothing before the first song or after the last", () => {
  setQueue([4, 9, 2]);
  assert.equal(neighbour(4, -1), 0);
  assert.equal(neighbour(2, 1), 0);
});

test("a song that is not in the list starts from the matching end", () => {
  setQueue([4, 9, 2]);
  assert.equal(neighbour(77, 1), 4);
  assert.equal(neighbour(77, -1), 2);
  setQueue([]);
  assert.equal(neighbour(77, 1), 0);
});
