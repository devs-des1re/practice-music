import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  KEYMAP,
  chordOf,
  commandFor,
  commandKeys,
  focusKeeps,
  helpGroups,
  type KeyLike,
} from "../../src/lib/keymap.ts";

function press(key: string, code: string, held: Partial<KeyLike> = {}): string {
  return chordOf({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });
}

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

test("no two actions on one page share a shortcut", () => {
  const scopes = new Set(KEYMAP.map((c) => c.scope).filter((s) => s !== "global"));
  for (const scope of scopes) {
    const used = new Map<string, string>();
    for (const command of KEYMAP.filter((c) => c.scope === scope || c.scope === "global")) {
      for (const chord of command.keys) {
        assert.equal(used.get(chord), undefined, `${chord} is both ${used.get(chord)} and ${command.id}`);
        used.set(chord, command.id);
      }
    }
  }
});

test("every action has its own name, a label and at least one key", () => {
  assert.equal(new Set(KEYMAP.map((c) => c.id)).size, KEYMAP.length);
  for (const command of KEYMAP) {
    assert.ok(command.label && command.group && command.keys.length > 0, command.id);
    assert.ok(command.scope === "global" ? command.id.startsWith("app.") : true, command.id);
  }
});

test("every shortcut hint on a button names a real action", () => {
  let found = 0;
  for (const file of sources("src")) {
    for (const [, id] of readFileSync(file, "utf8").matchAll(/data-command="([^"]+)"/g)) {
      found++;
      assert.ok(commandKeys(id), `${file} names ${id}`);
    }
  }
  assert.ok(found > 20);
});

test("key presses are named the same way on any keyboard layout", () => {
  assert.equal(press("m", "KeyM"), "M");
  assert.equal(press("M", "KeyM", { shiftKey: true }), "Shift+M");
  assert.equal(press('"', "Digit2", { shiftKey: true }), "Shift+2");
  assert.equal(press("<", "Comma", { shiftKey: true }), "Shift+,");
  assert.equal(press("?", "Slash", { shiftKey: true }), "Shift+/");
  assert.equal(press("?", "Minus", { shiftKey: true }), "Shift+/");
  assert.equal(press("?", ""), "Shift+/");
  assert.equal(press(",", ""), ",");
  assert.equal(press("]", ""), "]");
  assert.equal(press("+", "NumpadAdd"), "=");
  assert.equal(press(" ", "Space"), "Space");
  assert.equal(press("ArrowUp", "ArrowUp", { altKey: true }), "Alt+Up");
  assert.equal(press("o", "KeyO", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+O");
  assert.equal(press("o", "KeyO", { metaKey: true }), "Ctrl+O");
  assert.equal(press("a", "KeyQ"), "A");
  assert.equal(press("F2", "F2"), "F2");
  assert.equal(press("Shift", "ShiftLeft", { shiftKey: true }), "");
});

test("a shortcut only works on its own page, except the ones that work anywhere", () => {
  assert.deepEqual(commandFor("Space", "workspace"), { id: "player.play", at: 0 });
  assert.deepEqual(commandFor("Space", "drums"), { id: "drums.play", at: 0 });
  assert.deepEqual(commandFor("3", "workspace"), { id: "player.section", at: 2 });
  assert.equal(commandFor("M", "settings"), null);
  assert.equal(commandFor("Ctrl+2", "settings")?.id, "app.drums");
  assert.equal(commandFor("F1", "latency")?.id, "app.help");
});

test("typing and focused controls keep their own keys", () => {
  assert.ok(focusKeeps("text", "M"));
  assert.ok(focusKeeps("text", "Ctrl+O"));
  assert.ok(focusKeeps("slider", "Up"));
  assert.ok(focusKeeps("slider", "Shift+Left"));
  assert.ok(!focusKeeps("slider", "Alt+Up"));
  assert.ok(!focusKeeps("slider", "M"));
  assert.ok(focusKeeps("button", "Enter"));
  assert.ok(focusKeeps("button", "Space"));
  assert.ok(!focusKeeps("button", "M"));
  assert.ok(focusKeeps("check", "Space"));
  assert.ok(!focusKeeps("none", "Space"));
});

test("the help list covers every action for its page", () => {
  const rows = helpGroups("drums").flatMap((g) => g.rows);
  assert.equal(rows.length, KEYMAP.filter((c) => c.scope === "drums" || c.scope === "global").length);
  assert.ok(rows.some((r) => r.keys.includes("?")));
});
