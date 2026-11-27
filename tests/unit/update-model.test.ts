import { test } from "node:test";
import assert from "node:assert/strict";
import { installQuestion, updateBanner, updateStatus, type UpdateView } from "../../src/lib/update-model.ts";

const base: UpdateView = {
  phase: "available",
  current: "0.1.0-alpha.4",
  latest: "0.1.0-alpha.5",
  size: 6 * 1048576,
  done: 0,
  canInstall: true,
  hidden: false,
  error: "",
};

test("a newer version is offered with both version numbers", () => {
  const banner = updateBanner(base);
  assert.ok(banner.shown && banner.offer && !banner.busy);
  assert.match(banner.text, /0\.1\.0-alpha\.5 is available. You have 0\.1\.0-alpha\.4\./);
});

test("a computer with no installer is pointed at the release page", () => {
  const banner = updateBanner({ ...base, canInstall: false });
  assert.ok(banner.shown && !banner.offer);
  assert.match(banner.text, /release page/);
});

test("nothing shows until there is news, or after it is hidden", () => {
  for (const phase of ["idle", "checking", "current", "failed"]) {
    assert.equal(updateBanner({ ...base, phase }).shown, false);
  }
  assert.equal(updateBanner({ ...base, hidden: true }).shown, false);
});

test("progress and the closing message show even if the offer was hidden", () => {
  const busy = updateBanner({ ...base, phase: "downloading", done: 3 * 1048576, hidden: true });
  assert.ok(busy.shown && busy.busy);
  assert.match(busy.text, /50% of 6\.0 MB/);
  assert.ok(updateBanner({ ...base, phase: "opened", hidden: true }).shown);
});

test("a failed attempt says why and can be tried again", () => {
  const banner = updateBanner({ ...base, error: "Windows did not give permission to run it" });
  assert.ok(banner.offer);
  assert.match(banner.text, /failed: Windows did not give permission/);
});

test("the settings page explains each state", () => {
  assert.match(updateStatus({ ...base, phase: "current" }), /newest version/);
  assert.match(updateStatus({ ...base, phase: "failed", error: "GitHub answered 403" }), /403/);
  assert.match(updateStatus({ ...base, hidden: true }), /is available/);
  assert.match(updateStatus({ ...base, phase: "idle" }), /Not checked/);
});

test("the question before installing says what will happen", () => {
  const question = installQuestion(base);
  assert.match(question, /6\.0 MB/);
  assert.match(question, /closes PracticeMusic/);
});
