import { createSignal, onMount, onCleanup } from "@krate/runtime";
import { Dialog } from "@krate/components/dialog";
import { LiveText } from "../ui/live-text";
import { missingField, settleModal, subscribeModal, type ModalField, type ModalValues } from "../../lib/modal";

const FOCUS_DELAY_MS = 40;

interface ModalRow extends ModalField {
  id: string;
}

export function ModalHost() {
  const [modalOpen, setModalOpen] = createSignal(false);
  const [modalTitle, setModalTitle] = createSignal("");
  const [modalMessage, setModalMessage] = createSignal("");
  const [modalConfirm, setModalConfirm] = createSignal("OK");
  const [modalDanger, setModalDanger] = createSignal(false);
  const [modalRows, setModalRows] = createSignal<ModalRow[]>([]);

  const modalControl = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

  function submitModal() {
    const values: ModalValues = {};
    for (const row of modalRows()) values[row.key] = modalControl(row.id)?.value || "";
    const gap = missingField(modalRows(), values);
    if (gap) {
      const row = modalRows().find((r) => r.key === gap);
      if (row) modalControl(row.id)?.focus();
      return;
    }
    settleModal(values);
  }

  function pickSuggestion(id: string, value: string) {
    const el = modalControl(id);
    if (!el) return;
    el.value = value;
    el.focus();
  }

  function fillModal(next: ModalRow[]) {
    for (const row of next) {
      const el = modalControl(row.id);
      if (el) el.value = row.value || "";
    }
    const first = next.length > 0 ? modalControl(next[0].id) : document.getElementById("pm-modal-confirm");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }

  onMount(() => {
    const stop = subscribeModal((request) => {
      if (!request) {
        setModalOpen(false);
        return;
      }
      const next: ModalRow[] = request.fields.map((f) => ({ ...f, id: "pm-field-" + request.serial + "-" + f.key }));
      setModalTitle(request.title);
      setModalMessage(request.message);
      setModalConfirm(request.confirmLabel);
      setModalDanger(request.danger);
      setModalRows(next);
      setModalOpen(true);
      window.setTimeout(() => fillModal(next), FOCUS_DELAY_MS);
    });
    onCleanup(stop);
  });

  return (
    <Dialog
      id="pm-modal"
      class="pm-modal"
      label="Dialog"
      open={modalOpen()}
      onOpenChange={(next: boolean) => {
        if (!next) {
          setModalOpen(false);
          settleModal(null);
        }
      }}
    >
      <Dialog.Content class="pm-modal-content">
        <LiveText class="pm-modal-title" text={modalTitle()} />
        <div showIf={!!modalMessage()}>
          <LiveText class="pm-modal-message" text={modalMessage()} />
        </div>
        <div class="pm-modal-fields" showIf={modalRows().length > 0}>
          {modalRows().map((row) => (
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
                      submitModal();
                    }
                  }}
                />
              )}
              {(row.suggestions || []).length > 0 && (
                <div class="pm-modal-suggestions">
                  {(row.suggestions || []).map((name) => (
                    <button
                      class="krate-button krate-button-secondary krate-button-sm"
                      type="button"
                      key={name}
                      onClick={() => pickSuggestion(row.id, name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div class="pm-modal-actions">
          <button class="krate-button krate-button-secondary" type="button" onClick={() => settleModal(null)}>
            Cancel
          </button>
          <button
            id="pm-modal-confirm"
            class="krate-button krate-button-primary pm-modal-confirm"
            type="button"
            data-danger={modalDanger() ? "true" : "false"}
            onClick={submitModal}
          >
            <LiveText class="pm-modal-confirm-text" text={modalConfirm()} />
          </button>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
