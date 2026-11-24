import { test } from "node:test";
import assert from "node:assert/strict";
import {
  add,
  clampRatio,
  defaultTree,
  geometry,
  has,
  insertAt,
  leaves,
  move,
  normalise,
  parseTree,
  presetTree,
  remove,
  swap,
  withRatio,
  zoneAt,
  type Node,
  type PanelId,
} from "../../src/lib/layout.ts";

const only = (...ids: PanelId[]) => (id: PanelId) => ids.includes(id);

test("the default layout puts the decks on top and lower panels in a row below", () => {
  const tree = defaultTree(only("player", "metronome", "library", "mixer"));
  assert.deepEqual(leaves(tree), ["player", "metronome", "library", "mixer"]);
  const geo = geometry(tree);
  assert.ok(geo.rects.player && geo.rects.library);
  assert.ok(geo.rects.library.y > geo.rects.player.y);
  assert.ok(geo.rects.library.w < geo.rects.mixer!.w);
  assert.ok(Math.abs(geo.rects.library.w - 0.3) < 1e-9);
});

test("without lower panels only the two decks are laid out", () => {
  const tree = defaultTree(only("player", "metronome"));
  assert.deepEqual(leaves(tree), ["player", "metronome"]);
  assert.equal(geometry(tree).gutters.length, 1);
});

test("every rectangle fills the area with no gaps", () => {
  const tree = defaultTree(only("player", "metronome", "library", "mixer", "downloads"));
  const geo = geometry(tree);
  const total = Object.values(geo.rects).reduce((sum, r) => sum + r!.w * r!.h, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("removing a panel hands its space to its neighbour", () => {
  const tree = defaultTree(only("player", "metronome", "library"));
  const rest = remove(tree, "library") as Node;
  assert.deepEqual(leaves(rest), ["player", "metronome"]);
  assert.equal(remove(rest, "player") !== null, true);
  assert.equal(remove({ kind: "leaf", id: "player" }, "player"), null);
});

test("adding a lower panel splits the area below the decks first", () => {
  const base = defaultTree(only("player", "metronome"));
  const one = add(base, "library");
  const geo = geometry(one);
  assert.ok(geo.rects.library!.y > geo.rects.player!.y);
  assert.equal(geo.rects.library!.w, 1);
  const two = add(one, "mixer");
  const geo2 = geometry(two);
  assert.equal(geo2.rects.library!.y, geo2.rects.mixer!.y);
  assert.equal(add(two, "mixer"), two);
});

test("dropping on an edge puts the panel beside the target", () => {
  const tree = defaultTree(only("player", "metronome", "library"));
  const moved = move(tree, "library", "metronome", "left");
  const geo = geometry(moved);
  assert.ok(geo.rects.library!.x < geo.rects.metronome!.x);
  assert.equal(geo.rects.library!.y, geo.rects.metronome!.y);
  assert.deepEqual([...leaves(moved)].sort(), ["library", "metronome", "player"]);
});

test("dropping in the centre swaps two panels", () => {
  const tree = defaultTree(only("player", "metronome", "library"));
  const before = geometry(tree).rects;
  const swapped = geometry(move(tree, "player", "library", "center")).rects;
  assert.deepEqual(swapped.player, before.library);
  assert.deepEqual(swapped.library, before.player);
  assert.equal(swap(tree, "player", "player"), tree);
});

test("moving a panel onto itself changes nothing", () => {
  const tree = defaultTree(only("player", "metronome"));
  assert.equal(move(tree, "player", "player", "left"), tree);
});

test("insertAt wraps the target in a split of the right direction", () => {
  const tree: Node = { kind: "leaf", id: "player" };
  const below = insertAt(tree, "player", "library", "bottom");
  assert.equal(below.kind, "split");
  if (below.kind === "split") {
    assert.equal(below.dir, "col");
    assert.equal(below.b.kind === "leaf" && below.b.id, "library");
  }
});

test("a divider moves only the split it belongs to", () => {
  const tree = defaultTree(only("player", "metronome", "library"));
  const resized = withRatio(tree, "a", 0.4);
  const geo = geometry(resized);
  assert.ok(Math.abs(geo.rects.player!.w - 0.4) < 1e-9);
  assert.ok(Math.abs(geo.rects.library!.w - 1) < 1e-9);
});

test("ratios are kept clear of the minimum panel size", () => {
  assert.equal(clampRatio(0.01, 1000, 200), 0.2);
  assert.equal(clampRatio(0.99, 1000, 200), 0.8);
  assert.equal(clampRatio(0.5, 300, 200), 0.5);
  assert.equal(clampRatio(0.3, 0, 200), 0.5);
});

test("zones come from the nearest edge of the target", () => {
  assert.equal(zoneAt(0.1, 0.5), "left");
  assert.equal(zoneAt(0.9, 0.5), "right");
  assert.equal(zoneAt(0.5, 0.1), "top");
  assert.equal(zoneAt(0.5, 0.9), "bottom");
  assert.equal(zoneAt(0.5, 0.5), "center");
});

test("saved layouts are validated before use", () => {
  const good = JSON.parse(JSON.stringify(defaultTree(only("player", "metronome", "library"))));
  assert.ok(parseTree(good));
  assert.equal(parseTree({ kind: "leaf", id: "nope" }), null);
  assert.equal(parseTree({ kind: "split", dir: "row", ratio: 2, a: good, b: good }), null);
  assert.equal(parseTree("x"), null);
  assert.equal(parseTree(null), null);
});

test("normalise drops hidden panels, adds missing ones and rejects duplicates", () => {
  const saved = defaultTree(only("player", "metronome", "library", "mixer"));
  const fewer = normalise(saved, only("player", "metronome", "mixer"));
  assert.equal(has(fewer, "library"), false);
  assert.equal(has(fewer, "mixer"), true);
  const more = normalise(saved, only("player", "metronome", "library", "mixer", "downloads"));
  assert.equal(has(more, "downloads"), true);
  const dupes: Node = { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "player" }, b: { kind: "leaf", id: "player" } };
  assert.deepEqual([...leaves(normalise(dupes, only("player", "metronome")))].sort(), ["metronome", "player"]);
  assert.deepEqual([...leaves(normalise(null, only("player", "metronome")))].sort(), ["metronome", "player"]);
});

test("the mixing layout gives the mixer the top and the decks the bottom", () => {
  const tree = presetTree("mixing", only("player", "metronome", "library", "mixer"));
  assert.deepEqual(new Set(leaves(tree)), new Set(["player", "metronome", "library", "mixer"]));
  const geo = geometry(tree);
  assert.ok(geo.rects.mixer!.y < geo.rects.player!.y);
  assert.ok(geo.rects.mixer!.w > geo.rects.library!.w);
  const total = Object.values(geo.rects).reduce((sum, r) => sum + r!.w * r!.h, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("the practice layout is the default layout and presets cope with no lower panels", () => {
  const visible = only("player", "metronome", "library", "mixer");
  assert.deepEqual(presetTree("practice", visible), defaultTree(visible));
  const bare = only("player", "metronome");
  assert.deepEqual(leaves(presetTree("mixing", bare)), ["player", "metronome"]);
});
