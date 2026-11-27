import { createSignal, onMount, onCleanup } from "@krate/runtime";
import { Dialog } from "@krate/components/dialog";
import { LiveText } from "../ui/live-text";
import { missingField, settleModal, subscribeModal, type ModalField, type ModalValues } from "../../lib/modal";

const FOCUS_DELAY_MS = 40;

interface Row extends ModalField {
  id: string;
}

export function ModalHost() {
  const [open, setOpen] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [confirmLabel, setConfirmLabel] = createSignal("OK");
  const [danger, setDanger] = createSignal(false);
  const [rows, setRows] = createSignal<Row[]>([]);

  const control = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

  function submit() {
    const values: ModalValues = {};
    for (const row of rows()) values[row.key] = control(row.id)?.value || "";
    const gap = missingField(rows(), values);
    if (gap) {
      const row = rows().find((r) => r.key === gap);
      if (row) control(row.id)?.focus();
      return;
    }
    settleModal(values);
  }

  function pick(id: string, value: string) {
    const el = control(id);
    if (!el) return;
    el.value = value;
    el.focus();
  }

  function fill(next: Row[]) {
    for (const row of next) {
      const el = control(row.id);
      if (el) el.value = row.value || "";
    }
    const first = next.length > 0 ? control(next[0].id) : document.getElementById("pm-modal-confirm");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }

  onMount(() => {
    const stop = subscribeModal((request) => {
      if (!request) {
        setOpen(false);
        return;
      }
      const next = request.fields.map((f) => ({ ...f, id: "pm-field-" + request.serial + "-" + f.key }));
      setTitle(request.title);
      setMessage(request.message);
      setConfirmLabel(request.confirmLabel);
      setDanger(request.danger);
      setRows(next);
      setOpen(true);
      window.setTimeout(() => fill(next), FOCUS_DELAY_MS);
    });
    onCleanup(stop);
  });

  return (
    <Dialog
      id="pm-modal"
      class="pm-modal"
      label="Dialog"
      open={open()}
      onOpenChange={(next: boolean) => {
        if (!next) {
          setOpen(false);
          settleModal(null);
        }
      }}
    >
      <Dialog.Content class="pm-modal-content">
        <LiveText class="pm-modal-title" text={title()} />
        <div showIf={!!message()}>
          <LiveText class="pm-modal-message" text={message()} />
        </div>
        <div class="pm-modal-fields" showIf={rows().length > 0}>
          {rows().map((row) => (
            <div class="pm-modal-field" key={row.id}>
              <label class="field-label" for={row.id}>
                {row.label}
              </label>
              {row.type === "select" ? (
                <select id={row.id} class="krate-input pm-modal-select">
                  {(row.options || []).map((o) => (
                    <option value={o.value} key={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={row.id}
                  class="krate-input"
                  type={row.type === "url" ? "url" : "text"}
                  inputMode={row.type === "decimal" ? "decimal" : "text"}
                  placeholder={row.placeholder || ""}
                  maxLength={row.maxLength || 400}
                  autocomplete="off"
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
              {(row.suggestions || []).length > 0 && (
                <div class="pm-modal-suggestions">
                  {(row.suggestions || []).map((name) => (
                    <button class="krate-button krate-button-secondary krate-button-sm" type="button" key={name} onClick={() => pick(row.id, name)}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div class="pm-modal-actions">
          <button class="krate-button krate-button-ghost" type="button" onClick={() => settleModal(null)}>
            Cancel
          </button>
          <button id="pm-modal-confirm" class="krate-button krate-button-primary pm-modal-confirm" type="button" data-danger={danger() ? "true" : "false"} onClick={submit}>
            <LiveText class="pm-modal-confirm-text" text={confirmLabel()} />
          </button>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
