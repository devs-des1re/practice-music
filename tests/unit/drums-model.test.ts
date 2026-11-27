import test from "node:test";
import assert from "node:assert/strict";
import {
  addFiles,
  addHit,
  describeHit,
  fileName,
  kitProgressText,
  levelChoices,
  listeningInputs,
  loadText,
  notesText,
  padForHit,
  percentDone,
  portChoices,
  removeFile,
  resetPad,
  silentReason,
  soundChoices,
  soundSummary,
  type DrumPadShape,
  type DrumSettingsShape,
  type HitLine,
} from "../../src/lib/drums-model.ts";

function pad(id: string, label: string, sound: string, notes: number[]): DrumPadShape {
  return { id, label, sound, notes, files: [], gainDb: 0, pan: 0, tune: 0, sensitivity: 1, choke: 0 };
}

function settings(): DrumSettingsShape {
  return {
    kit: "muldjord",
    threshold: 10,
    pedalFollows: false,
    pedalThreshold: 80,
    pedalReversed: false,
    pads: [
      pad("snare", "Snare", "snare", [38, 40]),
      pad("hihat_closed", "Hi-hat closed", "hh_closed", [42]),
      pad("hihat_open", "Hi-hat open", "hh_open", [46]),
    ],
  };
}

const sounds = [{ id: "snare", label: "Snare" }];

test("the pedal only redirects hi-hat notes when it is switched on", () => {
  const s = settings();
  assert.equal(padForHit(s, 46, 120)?.id, "hihat_open");
  s.pedalFollows = true;
  assert.equal(padForHit(s, 46, 120)?.id, "hihat_closed");
  assert.equal(padForHit(s, 42, 0)?.id, "hihat_open");
  assert.equal(padForHit(s, 38, 120)?.id, "snare");
  s.pedalReversed = true;
  assert.equal(padForHit(s, 46, 120)?.id, "hihat_open");
  assert.equal(padForHit(s, 99, 0), null);
});

test("each monitor line names the pad, and says when a hit is unused or too light", () => {
  const s = settings();
  assert.deepEqual(describeHit(s, { seq: 1, kind: "hit", note: 38, value: 90 }, 0), {
    key: "1:hit:38:90",
    title: "Snare",
    detail: "note 38, strength 90",
    mapped: true,
  });
  assert.match(describeHit(s, { seq: 2, kind: "hit", note: 38, value: 4 }, 0).detail, /ignored/);
  const unknown = describeHit(s, { seq: 3, kind: "hit", note: 99, value: 50 }, 0);
  assert.equal(unknown.mapped, false);
  assert.equal(unknown.title, "No pad uses this note");
  assert.equal(describeHit(s, { seq: 4, kind: "pedal", note: 0, value: 127 }, 0).detail, "position 127");
});

test("the monitor keeps the newest lines and folds a moving pedal into one", () => {
  const s = settings();
  let list: HitLine[] = [];
  const add = (seq: number, kind: string, value: number) => {
    list = addHit(list, describeHit(s, { seq, kind, note: 38, value }, 0), 3);
  };
  add(1, "hit", 90);
  add(1, "hit", 90);
  assert.equal(list.length, 1);
  add(2, "pedal", 10);
  add(3, "pedal", 60);
  assert.deepEqual(
    list.map((l) => l.detail),
    ["position 60", "note 38, strength 90"],
  );
  add(4, "hit", 70);
  add(5, "hit", 71);
  assert.equal(list.length, 3);
});

test("a pad says what it will play", () => {
  const s = settings();
  const snare = s.pads[0];
  assert.equal(soundSummary(snare, sounds, "muldjord", true), "Snare");
  assert.equal(soundSummary(snare, sounds, "muldjord", false), "Kit not downloaded");
  assert.equal(soundSummary(snare, sounds, "none", false), "No kit chosen");
  assert.equal(soundSummary({ ...snare, sound: "none" }, sounds, "muldjord", true), "Silent");
  assert.equal(
    soundSummary({ ...snare, sound: "custom", files: ["C:\\a\\crack.wav"] }, sounds, "none", false),
    "crack.wav",
  );
  assert.equal(soundChoices(snare, sounds).at(-1)?.disabled, true);
});

test("adding own files switches the pad to them and removing the last one switches back", () => {
  const defaults = settings();
  let s = addFiles(settings(), "snare", ["/x/a.wav", "/x/b.wav", "/x/a.wav"]);
  assert.deepEqual(s.pads[0].files, ["/x/a.wav", "/x/b.wav"]);
  assert.equal(s.pads[0].sound, "custom");
  s = removeFile(s, defaults, "snare", "/x/a.wav");
  assert.equal(s.pads[0].sound, "custom");
  s = removeFile(s, defaults, "snare", "/x/b.wav");
  assert.equal(s.pads[0].sound, "snare");
});

test("resetting a pad takes its default notes back from other pads", () => {
  const defaults = settings();
  const s = settings();
  s.pads[0] = { ...s.pads[0], notes: [], gainDb: -6, sound: "none" };
  s.pads[1] = { ...s.pads[1], notes: [42, 38] };
  const out = resetPad(s, defaults, "snare");
  assert.deepEqual(out.pads[0].notes, [38, 40]);
  assert.equal(out.pads[0].gainDb, 0);
  assert.deepEqual(out.pads[1].notes, [42]);
});

test("progress and load text are written for the person waiting", () => {
  assert.equal(kitProgressText("downloading", 120e6, 346255411), "Downloading 120 MB of about 346 MB");
  assert.equal(kitProgressText("unpacking", 500, 1299), "Checking and unpacking recording 500 of 1299");
  assert.equal(percentDone(5, 0), 0);
  assert.equal(percentDone(500, 1000), 50);
  assert.equal(loadText("ready", 214, 214, 73e6, true), "214 recordings ready, 73 MB in memory");
  assert.equal(loadText("ready", 214, 214, 73e6, false), "The sounds load when audio is running.");
  assert.equal(loadText("ready", 2, 2, 420000, true), "2 recordings ready, 0.4 MB in memory");
});

test("small helpers", () => {
  assert.equal(notesText([]), "No MIDI note");
  assert.equal(notesText([36, 35]), "Notes 36, 35");
  assert.equal(fileName("D:/kits/snare 1.wav"), "snare 1.wav");
  assert.equal(levelChoices(0.6).length, levelChoices(1).length);
  assert.equal(
    levelChoices(0.33).some((c) => c.label === "33%"),
    true,
  );
  assert.deepEqual(
    listeningInputs([
      { kind: "song", main: 0 },
      { kind: "input", main: 0 },
      { kind: "input", main: -60 },
    ]).length,
    1,
  );
  assert.deepEqual(
    portChoices(["e-drum"], "old kit").map((c) => c.value),
    ["", "e-drum", "old kit"],
  );
});

test("the page says why hits are silent and offers the matching fix", () => {
  const s = { ...settings(), enabled: true, kit: "none" };
  const absent = { installed: false, phase: "" };
  const present = { installed: true, phase: "" };
  assert.equal(silentReason(s, absent, "idle", true).fix, "choose");
  assert.equal(silentReason({ ...s, kit: "muldjord" }, absent, "idle", true).fix, "download");
  assert.equal(silentReason({ ...s, enabled: false }, present, "ready", true).fix, "enable");
  assert.equal(silentReason({ ...s, kit: "muldjord" }, present, "ready", true).text, "");
  assert.equal(silentReason({ ...s, kit: "muldjord" }, present, "loading", true).text, "");
  assert.equal(
    silentReason({ ...s, kit: "muldjord" }, { installed: false, phase: "downloading" }, "idle", true).text,
    "",
  );
  assert.match(silentReason({ ...s, kit: "muldjord" }, present, "idle", false).text, /Audio is not running/);
  assert.match(silentReason({ ...s, kit: "muldjord" }, present, "failed", true).text, /could not be loaded/);
  assert.match(silentReason({ ...s, kit: "muldjord" }, present, "idle", true).text, /each pad/);
});

test("your own files count as sounds even with no kit chosen", () => {
  const s = { ...settings(), enabled: true, kit: "none" };
  s.pads[0] = { ...s.pads[0], sound: "custom", files: ["/x/a.wav"] };
  const absent = { installed: false, phase: "" };
  assert.equal(silentReason(s, absent, "ready", true).text, "");
  assert.match(silentReason(s, absent, "idle", false).text, /Audio is not running/);
});
