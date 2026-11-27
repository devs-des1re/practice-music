import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, isOffline, retryDelayMs, countdownText } from "../../src/lib/errors.ts";

test("network failures are recognised as the host being unreachable", () => {
  assert.equal(isOffline(new TypeError("Failed to fetch")), true);
  assert.equal(isOffline(new Error("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isOffline("Load failed"), true);
  assert.equal(
    isOffline(
      new Error(
        'Go host is not reachable: Post "http://gohost/__krate/call": dial unix g003.sock: connect: No connection could be made',
      ),
    ),
    true,
  );
  assert.equal(describeError(new Error("connection refused")), "The PracticeMusic host is not reachable.");
  assert.equal(isOffline(new Error("audio_error: the selected output device is not connected")), false);
});

test("error messages lose their code prefix and read as sentences", () => {
  assert.equal(
    describeError(new Error("audio_error: the selected output device is not connected")),
    "The selected output device is not connected.",
  );
  assert.equal(describeError(new Error("Something broke.")), "Something broke.");
  assert.equal(describeError(new TypeError("Failed to fetch")), "The PracticeMusic host is not reachable.");
  assert.equal(describeError(""), "Something went wrong.");
});

test("retries back off and settle at thirty seconds", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(retryDelayMs), [3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  assert.equal(retryDelayMs(-3), 3000);
});

test("the countdown reads in whole seconds", () => {
  assert.equal(countdownText(0, 1000), "");
  assert.equal(countdownText(13500, 1000), "Trying again in 13 seconds.");
  assert.equal(countdownText(1500, 1000), "Trying again now.");
});
