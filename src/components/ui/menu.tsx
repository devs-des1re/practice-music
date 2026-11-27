import { createEffect, onMount, onCleanup } from "@krate/runtime";

export interface MenuItem {
  label: string;
  keys?: string;
  tone?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export interface MenuProps {
  id: string;
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 6;

export function Menu(props: MenuProps) {
  createEffect(() => {
    const open = props.open;
    const x = props.x;
    const y = props.y;
    if (!open || typeof document === "undefined") return;
    requestAnimationFrame(() => {
      const el = document.getElementById(props.id);
      if (!el) return;
      const left = Math.max(EDGE, Math.min(window.innerWidth - el.offsetWidth - EDGE, x));
      const top = Math.max(EDGE, Math.min(window.innerHeight - el.offsetHeight - EDGE, y));
      el.style.left = left + "px";
      el.style.top = top + "px";
      (el.querySelector(".menu-item:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });
    });
  });

  onMount(() => {
    const down = (e: PointerEvent) => {
      if (!props.open) return;
      const el = document.getElementById(props.id);
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (!props.open) return;
      if (e.key === "Escape") {
        props.onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const el = document.getElementById(props.id);
      const items = Array.from(el?.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)") || []);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const move = e.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? 0 : (at + move + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    };
    const leave = () => {
      if (props.open) props.onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", leave);
    window.addEventListener("resize", leave);
    onCleanup(() => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", leave);
      window.removeEventListener("resize", leave);
    });
  });

  return (
    <div class="menu" id={props.id} role="menu" data-on={props.open ? "true" : "false"}>
      {props.items.map((item, i) =>
        item.separator ? (
          <div class="menu-sep" key={"sep" + i} role="separator" />
        ) : (
          <button
            class="menu-item"
            type="button"
            role="menuitem"
            key={item.label + i}
            data-tone={item.tone || ""}
            disabled={item.disabled}
            onClick={() => {
              props.onClose();
              if (item.onSelect) item.onSelect();
            }}
          >
            <span>{item.label}</span>
            <span class="menu-key" showIf={!!item.keys}>
              {item.keys || ""}
            </span>
          </button>
        ),
      )}
    </div>
  );
}
