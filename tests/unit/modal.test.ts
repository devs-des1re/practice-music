import { test } from "node:test";
import assert from "node:assert/strict";
import { askConfirm, askForm, askText, missingField, settleModal, subscribeModal } from "../../src/lib/modal.ts";
import type { ModalRequest } from "../../src/lib/modal.ts";

test("a confirmation resolves true when accepted and false when cancelled", async () => {
  const first = askConfirm({ title: "Delete", message: "Sure?", confirmLabel: "Delete", danger: true });
  settleModal({});
  assert.equal(await first, true);
  const second = askConfirm({ title: "Delete", message: "Sure?", confirmLabel: "Delete" });
  settleModal(null);
  assert.equal(await second, false);
});

test("a name is trimmed and an empty one counts as cancelled", async () => {
  const named = askText({ title: "Save", label: "Name", confirmLabel: "Save" });
  settleModal({ name: "  Chorus  " });
  assert.equal(await named, "Chorus");
  const blank = askText({ title: "Save", label: "Name", confirmLabel: "Save" });
  settleModal({ name: "   " });
  assert.equal(await blank, null);
});

test("a form keeps optional fields empty and reports the first required gap", async () => {
  const fields = [
    { key: "title", label: "Title", required: true },
    { key: "album", label: "Album" },
  ];
  assert.equal(missingField(fields, { title: " ", album: "x" }), "title");
  assert.equal(missingField(fields, { title: "a", album: "" }), "");
  const form = askForm({ title: "Edit", confirmLabel: "Save", fields });
  settleModal({ title: " Song ", album: "" });
  assert.deepEqual(await form, { title: "Song", album: "" });
});

test("opening a second modal cancels the first and listeners see the current one", async () => {
  const seen: (ModalRequest | null)[] = [];
  const stop = subscribeModal((r) => seen.push(r));
  const first = askConfirm({ title: "One", message: "", confirmLabel: "Ok" });
  const second = askConfirm({ title: "Two", message: "", confirmLabel: "Ok" });
  assert.equal(await first, false);
  assert.equal(seen[seen.length - 1]?.title, "Two");
  settleModal({});
  assert.equal(await second, true);
  assert.equal(seen[seen.length - 1], null);
  stop();
});

test("settling with nothing open does nothing", () => {
  assert.doesNotThrow(() => settleModal(null));
});
