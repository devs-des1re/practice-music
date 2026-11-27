import { test } from "node:test";
import assert from "node:assert/strict";
import { takenName } from "../../src/lib/names.ts";
import { fieldProblem } from "../../src/lib/modal.ts";

test("a name already in use is caught whatever its capitals or spacing", () => {
  const lists = ["test", "Warm up"];
  for (const wanted of ["test", "TEST", "  Test  ", "warm   up"]) {
    assert.match(takenName(wanted, lists, "playlist"), /already have a playlist called/, wanted);
  }
  assert.match(takenName("WARM UP", lists, "scene"), /a scene called "Warm up"/);
});

test("a new name is allowed", () => {
  assert.equal(takenName("tests", ["test"], "playlist"), "");
  assert.equal(takenName("warmup", ["Warm up"], "playlist"), "");
  assert.equal(takenName("anything", [], "playlist"), "");
});

test("a popup reports the first field whose check fails, using the trimmed text", () => {
  const seen: string[] = [];
  const fields = [
    { key: "title", label: "Title" },
    {
      key: "name",
      label: "Name",
      check: (value: string) => {
        seen.push(value);
        return takenName(value, ["test"], "playlist");
      },
    },
  ];
  assert.equal(fieldProblem(fields, { title: "x", name: "  Test " })?.key, "name");
  assert.equal(fieldProblem(fields, { title: "x", name: "fresh" }), null);
  assert.deepEqual(seen, ["Test", "fresh"]);
});
