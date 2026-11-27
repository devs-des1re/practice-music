import { faderKeyValue, faderValueAt } from "../../lib/fader";

export interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  marks: number[];
  onInput: (value: number) => void;
  onReset?: () => void;
}

function markText(db: number): string {
  if (db <= -60) return "off";
  if (db > 0) return "+" + db;
  return String(db);
}

export function Fader(props: FaderProps) {
  const valueOf = (el: HTMLElement) => Number(el.getAttribute("aria-valuenow"));

  const drag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const thumb = el.querySelector(".fader-thumb") as HTMLElement | null;
    if (!thumb) return;
    el.focus();
    el.setPointerCapture(e.pointerId);
    const box = thumb.getBoundingClientRect();
    const onThumb = e.clientY >= box.top && e.clientY <= box.bottom;
    const grab = onThumb ? e.clientY - (box.top + box.height / 2) : 0;
    const follow = (y: number) => {
      const area = el.getBoundingClientRect();
      const half = thumb.offsetHeight / 2;
      const next = faderValueAt(y - grab - area.top - half, area.height - half * 2, props.min, props.max, props.step);
      if (next !== valueOf(el)) props.onInput(next);
    };
    const move = (ev: PointerEvent) => follow(ev.clientY);
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.removeEventListener("lostpointercapture", end);
      el.dataset.dragging = "false";
    };
    el.dataset.dragging = "true";
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    if (!onThumb) follow(e.clientY);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.currentTarget as HTMLElement;
    const next = faderKeyValue(e.key, valueOf(el), props.min, props.max, props.step);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== valueOf(el)) props.onInput(next);
  };

  return (
    <div class="fader">
      <div class="fader-scale" aria-hidden="true">
        {props.marks.map((m) => (
          <span class="fader-mark" key={m} style={"--p:" + (props.max - m) / (props.max - props.min)}>
            {markText(m)}
          </span>
        ))}
      </div>
      <div
        class="fader-input"
        role="slider"
        tabindex={0}
        aria-orientation="vertical"
        aria-label={props.label}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        data-tip={props.label + ". Double-click to reset."}
        style={"--p:" + (props.value - props.min) / (props.max - props.min)}
        onPointerDown={drag}
        onKeyDown={onKey}
        onDoubleClick={() => {
          if (props.onReset) props.onReset();
        }}
      >
        <span class="fader-track" />
        <span class="fader-thumb" />
      </div>
    </div>
  );
}
