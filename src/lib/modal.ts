export type FieldType = "text" | "decimal" | "url" | "select";

export interface ModalOption {
  value: string;
  label: string;
}

export interface ModalField {
  key: string;
  label: string;
  type?: FieldType;
  value?: string;
  placeholder?: string;
  options?: ModalOption[];
  suggestions?: string[];
  maxLength?: number;
  required?: boolean;
}

export type ModalValues = Record<string, string>;

export interface ModalRequest {
  serial: number;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  fields: ModalField[];
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

export interface FormOptions {
  title: string;
  confirmLabel: string;
  message?: string;
  fields: ModalField[];
}

export interface TextOptions {
  title: string;
  label: string;
  confirmLabel: string;
  message?: string;
  value?: string;
  placeholder?: string;
  suggestions?: string[];
  maxLength?: number;
}

interface ModalShared {
  serial: number;
  request: ModalRequest | null;
  resolve: ((answer: ModalValues | null) => void) | null;
  listeners: Set<(request: ModalRequest | null) => void>;
}

function modalState(): ModalShared {
  const holder = globalThis as unknown as { __pmModal?: ModalShared };
  if (!holder.__pmModal) holder.__pmModal = { serial: 0, request: null, resolve: null, listeners: new Set() };
  return holder.__pmModal;
}

function publishModal(request: ModalRequest | null) {
  const store = modalState();
  store.request = request;
  for (const fn of store.listeners) fn(request);
}

function openModal(request: Omit<ModalRequest, "serial">): Promise<ModalValues | null> {
  modalState().resolve?.(null);
  modalState().serial += 1;
  return new Promise((resolve) => {
    modalState().resolve = resolve;
    publishModal({ ...request, serial: modalState().serial });
  });
}

export function subscribeModal(fn: (request: ModalRequest | null) => void): () => void {
  modalState().listeners.add(fn);
  fn(modalState().request);
  return () => {
    modalState().listeners.delete(fn);
  };
}

export function missingField(fields: ModalField[], values: ModalValues): string {
  const gap = fields.find((f) => f.required && !(values[f.key] || "").trim());
  return gap ? gap.key : "";
}

export function settleModal(answer: ModalValues | null) {
  const resolve = modalState().resolve;
  if (!resolve) return;
  modalState().resolve = null;
  publishModal(null);
  resolve(answer);
}

export async function askConfirm(options: ConfirmOptions): Promise<boolean> {
  const answer = await openModal({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    danger: !!options.danger,
    fields: [],
  });
  return answer !== null;
}

export async function askForm(options: FormOptions): Promise<ModalValues | null> {
  const answer = await openModal({
    title: options.title,
    message: options.message || "",
    confirmLabel: options.confirmLabel,
    danger: false,
    fields: options.fields,
  });
  if (answer === null) return null;
  const trimmed: ModalValues = {};
  for (const key of Object.keys(answer)) trimmed[key] = answer[key].trim();
  return missingField(options.fields, trimmed) ? null : trimmed;
}

export async function askText(options: TextOptions): Promise<string | null> {
  const answer = await askForm({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    fields: [
      {
        key: "name",
        label: options.label,
        value: options.value,
        placeholder: options.placeholder,
        suggestions: options.suggestions,
        maxLength: options.maxLength,
        required: true,
      },
    ],
  });
  return answer === null ? null : answer.name;
}
