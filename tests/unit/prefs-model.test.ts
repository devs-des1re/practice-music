import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOWNLOAD_CHOICES, FALLBACK_PREFERENCES, downloadDefault } from "../../src/lib/prefs-model.ts";

const go = readFileSync(new URL("../../api/settings/preferences.go", import.meta.url), "utf8");

test("the interface starts from the same defaults as the settings file", () => {
  const block = go.slice(go.indexOf("func DefaultPreferences()"), go.indexOf("func within["));
  const found: Record<string, unknown> = {};
  for (const match of block.matchAll(/^\t\t(\w+):\s+(.+),$/gm)) {
    const key = match[1].charAt(0).toLowerCase() + match[1].slice(1);
    found[key] = JSON.parse(match[2]);
  }
  assert.deepEqual(found, { ...FALLBACK_PREFERENCES });
});

test("every download choice is one the settings file accepts", () => {
  for (const choice of DOWNLOAD_CHOICES) assert.ok(go.includes('"' + choice.value + '"'), choice.value);
});

test("a fixed download default wins over the last one used", () => {
  assert.equal(downloadDefault("mp4:720", "mp3:128"), "mp4:720");
  assert.equal(downloadDefault("last", "mp3:128"), "mp3:128");
  assert.equal(downloadDefault("last", null), "mp3:best");
  assert.equal(downloadDefault("last", "wav:1"), "mp3:best");
});
