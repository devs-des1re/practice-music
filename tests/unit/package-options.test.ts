import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setNativeVersion } from "../../scripts/package-options.mjs";

test("a release tag replaces the version in the real config, whichever quotes it uses", () => {
  const config = readFileSync(new URL("../../krate.config.ts", import.meta.url), "utf8");
  const next = setNativeVersion(config, "9.8.7-alpha.1");
  assert.match(next, /version: "9\.8\.7-alpha\.1"/);
  assert.equal(next.replace("9.8.7-alpha.1", "0.1.0"), config);
  assert.equal(setNativeVersion("native: { version: '1.0.0' }", "2.0.0"), "native: { version: '2.0.0' }");
  assert.throws(() => setNativeVersion("native: {}", "2.0.0"));
});
