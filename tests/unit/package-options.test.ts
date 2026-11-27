import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installerFormats, setHostVersion, setNativeVersion, targetArch } from "../../scripts/package-options.mjs";

test("each system gets its own installer formats", () => {
  assert.equal(installerFormats("windows"), "nsis");
  assert.equal(installerFormats("darwin"), "dmg");
  assert.equal(installerFormats("linux"), "deb,rpm");
  assert.throws(() => installerFormats("plan9"));
});

test("the architecture defaults to this machine and universal is only for macOS", () => {
  assert.equal(targetArch("linux", undefined, "x64"), "amd64");
  assert.equal(targetArch("darwin", "", "arm64"), "arm64");
  assert.equal(targetArch("darwin", "universal", "arm64"), "universal");
  assert.throws(() => targetArch("windows", "universal", "x64"));
  assert.throws(() => targetArch("linux", "sparc", "x64"));
});

test("a release tag replaces the version in the real config, whichever quotes it uses", () => {
  const config = readFileSync(new URL("../../krate.config.ts", import.meta.url), "utf8");
  const next = setNativeVersion(config, "9.8.7-alpha.1");
  assert.match(next, /version: "9\.8\.7-alpha\.1"/);
  assert.equal(next.replace("9.8.7-alpha.1", "0.1.0"), config);
  assert.equal(setNativeVersion("native: { version: '1.0.0' }", "2.0.0"), "native: { version: '2.0.0' }");
  assert.throws(() => setNativeVersion("native: {}", "2.0.0"));
});

test("a release tag also reaches the version the app reports about itself", () => {
  const host = readFileSync(new URL("../../api/host.go", import.meta.url), "utf8");
  const next = setHostVersion(host, "9.8.7-alpha.1");
  assert.match(next, /const Version = "9\.8\.7-alpha\.1"/);
  assert.equal(next.replace("9.8.7-alpha.1", "0.1.0"), host);
  assert.throws(() => setHostVersion("package api", "2.0.0"));
});
