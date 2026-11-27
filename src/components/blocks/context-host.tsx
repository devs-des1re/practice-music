import { createSignal, onMount, onCleanup } from "@krate/runtime";
import { Menu, type MenuItem } from "../ui/menu";
import { DIVIDER, openContextMenu, subscribeContext, type ContextItem } from "../../lib/context-menu";
import { askConfirm } from "../../lib/modal";
import { logger } from "../../lib/logger";

const TEXT_TYPES = ["text", "search", "url", "email", "password", "number", "tel"];

function textField(target: Element): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_TYPES.includes(target.type)) return target;
  return null;
}

function fieldItems(field: HTMLInputElement | HTMLTextAreaElement): ContextItem[] {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const locked = field.readOnly || field.disabled;
  const restore = () => {
    field.focus();
    if (field.selectionStart !== null) field.setSelectionRange(start, end);
  };
  const run = (command: string) => () => {
    restore();
    document.execCommand(command);
  };
  const paste = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        restore();
        field.setRangeText(text, start, end, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch((e) => {
        logger.warn("paste was blocked", e);
        void askConfirm({
          title: "Paste was blocked",
          message: "The app was not allowed to read the clipboard. Press Ctrl and V to paste instead.",
          confirmLabel: "OK",
        });
      });
  };
  return [
    { label: "Cut", keys: "Ctrl+X", disabled: locked || start === end, onSelect: run("cut") },
    { label: "Copy", keys: "Ctrl+C", disabled: start === end, onSelect: run("copy") },
    { label: "Paste", keys: "Ctrl+V", disabled: locked, onSelect: paste },
    DIVIDER,
    {
      label: "Select all",
      keys: "Ctrl+A",
      disabled: field.value.length === 0,
      onSelect: () => {
        field.focus();
        field.select();
      },
    },
  ];
}

function press(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null;
  el?.click();
}

function pageItems(): ContextItem[] {
  const selected = (window.getSelection()?.toString() || "").length > 0;
  const onWorkspace = !!document.querySelector(".ws");
  const items: ContextItem[] = [];
  if (selected)
    items.push({ label: "Copy", keys: "Ctrl+C", onSelect: () => void document.execCommand("copy") }, DIVIDER);
  if (onWorkspace)
    items.push({
      label: "Keyboard shortcuts",
      keys: "?",
      onSelect: () => press('.topbar [aria-label="Keyboard shortcuts"]'),
    });
  else items.push({ label: "Back to the workspace", onSelect: () => press('.topbar a[href="/"]') });
  items.push({ label: "Settings", onSelect: () => press('.topbar a[href="/settings"]') });
  items.push({ label: "Latency tools", onSelect: () => press('.topbar a[href="/latency"]') });
  return items;
}

export function ContextHost() {
  const [contextOpen, setContextOpen] = createSignal(false);
  const [contextX, setContextX] = createSignal(0);
  const [contextY, setContextY] = createSignal(0);
  const [contextList, setContextList] = createSignal<MenuItem[]>([]);

  onMount(() => {
    const menu = () => document.getElementById("app-context-menu");
    const choose = (e: Event) => {
      const button = e.target instanceof Element ? e.target.closest("#app-context-menu .menu-item") : null;
      if (!button) return;
      e.stopPropagation();
      const buttons = Array.from(menu()?.querySelectorAll(".menu-item") || []);
      const item = contextList().filter((x) => !x.separator)[buttons.indexOf(button)];
      setContextOpen(false);
      item?.onSelect?.();
    };
    window.addEventListener("click", choose, true);
    const stop = subscribeContext((request) => {
      if (!request || request.items.length === 0) return;
      setContextList(request.items);
      setContextX(request.x);
      setContextY(request.y);
      setContextOpen(true);
      menu()?.removeAttribute("inert");
      requestAnimationFrame(() => menu()?.removeAttribute("inert"));
    });
    const fallback = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest("#app-context-menu, .menu")) {
        e.preventDefault();
        return;
      }
      const field = textField(target);
      openContextMenu(e, field ? fieldItems(field) : pageItems());
    };
    window.addEventListener("contextmenu", fallback);
    onCleanup(() => {
      window.removeEventListener("click", choose, true);
      stop();
      window.removeEventListener("contextmenu", fallback);
    });
  });

  return (
    <Menu
      id="app-context-menu"
      open={contextOpen()}
      x={contextX()}
      y={contextY()}
      items={contextList()}
      onClose={() => setContextOpen(false)}
    />
  );
}
