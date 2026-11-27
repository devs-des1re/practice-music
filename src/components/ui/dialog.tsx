import { onMount, onCleanup } from "@krate/runtime";

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: any;
}

export function Dialog(props: DialogProps) {
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) props.onClose();
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  return (
    <div
      class="dialog-scrim"
      data-on={props.open ? "true" : "false"}
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section class="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <header class="dialog-head">
          <h2 class="dialog-title">{props.title}</h2>
          <button
            class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
            type="button"
            aria-label="Close"
            data-tip="Close"
            data-keys="Esc"
            onClick={props.onClose}
          >
            <Icon name="lucide:x" />
          </button>
        </header>
        <div class="dialog-body">{props.children}</div>
      </section>
    </div>
  );
}
