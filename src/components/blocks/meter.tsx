import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { AudioStream } from "../../../api/audio.go";
import { MeterStream, ResetMeters } from "../../../api/session.go";
import { meterFraction } from "../../lib/mixer";

export interface MeterProps {
  which: string;
  label: string;
}

interface Level {
  l: number;
  r: number;
  clip: boolean;
  gr: number;
}

const WIDTH = 34;
const BAR = 10;
const GAP = 3;
const CLIP_HEIGHT = 5;
const HOLD_MS = 1200;
const GREEN_TOP = 0.8;
const AMBER_TOP = 0.95;
const quiet: Level = { l: 0, r: 0, clip: false, gr: 0 };

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Meter(props: MeterProps) {
  const [size, setSize] = createSignal(0);
  const [level, setLevel] = createSignal<Level>(quiet);
  const hold = { l: 0, r: 0, lAt: 0, rAt: 0 };
  const canvasId = "meter-" + props.which;

  createEffect(() => {
    const running = AudioStream()?.running;
    const frame = MeterStream();
    if (!running || !frame) {
      setLevel(quiet);
      return;
    }
    if (props.which === "main") setLevel(frame.main);
    else if (props.which === "monitor") setLevel(frame.monitor);
    else setLevel(frame.strips[Number(props.which)] || quiet);
  });

  createEffect(() => {
    size();
    const lv = level();
    const el = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!el) return;
    const height = el.clientHeight;
    if (height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.floor(WIDTH * dpr);
    el.height = Math.floor(height * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    const off = token("--color-meter-off");
    const green = token("--color-meter-green");
    const amber = token("--color-meter-amber");
    const red = token("--color-meter-red");
    const bars = [
      { value: lv.l, x: 3, key: "l" },
      { value: lv.r, x: 3 + BAR + GAP, key: "r" },
    ];
    ctx.clearRect(0, 0, WIDTH, height);
    ctx.fillStyle = lv.clip ? red : off;
    ctx.fillRect(3, 0, BAR * 2 + GAP, CLIP_HEIGHT);
    const top = CLIP_HEIGHT + 2;
    const span = height - top;
    ctx.fillStyle = off;
    ctx.fillRect(WIDTH - 5, top, 3, span);
    if (lv.gr > 0) {
      ctx.fillStyle = amber;
      ctx.fillRect(WIDTH - 5, top, 3, span * Math.min(1, lv.gr / 24));
    }
    for (const bar of bars) {
      const frac = meterFraction(bar.value);
      const heldValue = bar.key === "l" ? hold.l : hold.r;
      const heldAt = bar.key === "l" ? hold.lAt : hold.rAt;
      let held = heldValue;
      if (frac >= held || now - heldAt > HOLD_MS) {
        held = frac;
        if (bar.key === "l") {
          hold.l = frac;
          hold.lAt = now;
        } else {
          hold.r = frac;
          hold.rAt = now;
        }
      }
      ctx.fillStyle = off;
      ctx.fillRect(bar.x, top, BAR, span);
      const greenTo = Math.min(frac, GREEN_TOP);
      const amberTo = Math.min(frac, AMBER_TOP);
      ctx.fillStyle = green;
      ctx.fillRect(bar.x, top + span * (1 - greenTo), BAR, span * greenTo);
      if (frac > GREEN_TOP) {
        ctx.fillStyle = amber;
        ctx.fillRect(bar.x, top + span * (1 - amberTo), BAR, span * (amberTo - GREEN_TOP));
      }
      if (frac > AMBER_TOP) {
        ctx.fillStyle = red;
        ctx.fillRect(bar.x, top + span * (1 - frac), BAR, span * (frac - AMBER_TOP));
      }
      if (held > 0.01) {
        ctx.fillStyle = token("--color-text");
        ctx.fillRect(bar.x, top + span * (1 - held) - 1, BAR, 2);
      }
    }
  });

  onMount(() => {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const observer = new ResizeObserver(() => setSize(el.clientHeight));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
    setSize(el.clientHeight);
  });

  return (
    <div class="meter-box">
      <canvas
        id={canvasId}
        class="meter"
        role="img"
        aria-label={props.label + " level. Click to clear the clip light."}
        title="Click to clear the clip light"
        onClick={() => ResetMeters().catch(() => undefined)}
      />
    </div>
  );
}
