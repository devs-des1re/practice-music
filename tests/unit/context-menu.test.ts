import { test } from "node:test";
import assert from "node:assert/strict";
import { DIVIDER, openContextMenu, subscribeContext, tidyItems, type ContextRequest } from "../../src/lib/context-menu.ts";

test("dividers never lead, trail or double up", () => {
  const items = tidyItems([DIVIDER, { label: "a" }, DIVIDER, DIVIDER, { label: "b" }, DIVIDER]);
  assert.deepEqual(items.map((i) => (i.separator ? "-" : i.label)), ["a", "-", "b"]);
  assert.deepEqual(tidyItems([DIVIDER]), []);
});

test("opening the menu blocks the web view menu and reaches the host", () => {
  let blocked = false;
  const seen: (ContextRequest | null)[] = [];
  const stop = subscribeContext((r) => seen.push(r));
  openContextMenu({ clientX: 12, clientY: 34, preventDefault: () => (blocked = true) }, [{ label: "Play" }]);
  stop();
  openContextMenu({ clientX: 0, clientY: 0, preventDefault: () => undefined }, [{ label: "Later" }]);
  assert.equal(blocked, true);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0]?.x, seen[0]?.y, seen[0]?.items[0].label], [12, 34, "Play"]);
});
