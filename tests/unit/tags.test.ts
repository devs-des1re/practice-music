import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTags, tagChanges } from "../../src/lib/tags.ts";

test("tags are split on commas without blanks or repeats", () => {
  assert.deepEqual(splitTags(" rock, ,Fill ,ROCK,"), ["rock", "Fill"]);
  assert.deepEqual(splitTags(""), []);
});

test("only the tags that changed are added or removed", () => {
  assert.deepEqual(tagChanges(["rock", "slow"], ["rock", "fills"]), { added: ["fills"], removed: ["slow"] });
  assert.deepEqual(tagChanges(["rock"], ["rock"]), { added: [], removed: [] });
});
