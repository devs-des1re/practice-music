import { onMount, onCleanup } from "@krate/runtime";
import { currentPrefs, ensurePrefs } from "../../lib/prefs";

const GAP = 6;
const EDGE = 4;

export function TooltipHost() {
  onMount(() => {
    ensurePrefs();
    let timer = 0;
    let current: Element | null = null;

    const box = () => document.getElementById("tip");

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      const tip = box();
      if (tip) tip.dataset.on = "false";
    };

    const show = (target: Element) => {
      const tip = box();
      if (!tip) return;
      tip.textContent = "";
      const label = document.createElement("span");
      label.textContent = target.getAttribute("data-tip") || "";
      tip.appendChild(label);
      const keys = target.getAttribute("data-keys");
      if (keys) {
        const key = document.createElement("span");
        key.className = "kbd";
        key.textContent = keys;
        tip.appendChild(key);
      }
      tip.dataset.on = "true";
      const r = target.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, r.left + r.width / 2 - w / 2));
      const below = r.bottom + GAP;
      const y = below + h > window.innerHeight - EDGE ? Math.max(EDGE, r.top - h - GAP) : below;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    };

    const over = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const target = el && el.closest ? el.closest("[data-tip]") : null;
      if (target === current) return;
      hide();
      if (!target || !currentPrefs().tooltips) return;
      current = target;
      timer = window.setTimeout(() => show(target), currentPrefs().tooltipDelayMs);
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    document.documentElement.addEventListener("mouseleave", hide);
    onCleanup(() => {
      hide();
      document.removeEventListener("mouseover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
      document.documentElement.removeEventListener("mouseleave", hide);
    });
  });

  return <div id="tip" class="tip" data-on="false" role="tooltip" />;
}
