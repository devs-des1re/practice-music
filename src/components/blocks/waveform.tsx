import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { snapTime, gridLines, hitHandle, orderRegion, type GridInfo, type SnapMode } from "../../lib/waveform";

export interface WaveformProps {
  peaks: number[];
  durationMs: number;
  positionMs: number;
  loopStart: number;
  loopEnd: number;
  loopOn: boolean;
  gridBpm: number;
  gridOffset: number;
  gridBeats: number;
  gridDownbeat: number;
  snap: SnapMode;
  onSeek: (ms: number) => void;
  onLoop: (start: number, end: number) => void;
}

const HEIGHT = 168;
const GRAB = 9;
const MIN_LOOP_MS = 80;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Waveform(props: WaveformProps) {
  const [size, setSize] = createSignal(0);
  const [dragStart, setDragStart] = createSignal(-1);
  const [dragEnd, setDragEnd] = createSignal(-1);
  const drag = { mode: "none" as "none" | "select" | "start" | "end", anchor: 0, moved: false, startX: 0 };

  function canvas(): HTMLCanvasElement | null {
    return document.getElementById("waveform") as HTMLCanvasElement | null;
  }

  function grid(): GridInfo | null {
    if (props.gridBpm <= 0) return null;
    return { bpm: props.gridBpm, offsetMs: props.gridOffset, beatsPerBar: props.gridBeats, downbeat: props.gridDownbeat };
  }

  function region(): { start: number; end: number; on: boolean } {
    if (dragStart() >= 0 && dragEnd() >= 0) return { start: dragStart(), end: dragEnd(), on: true };
    return { start: props.loopStart, end: props.loopEnd, on: props.loopOn };
  }

  function toMs(x: number, width: number): number {
    return (x / Math.max(1, width)) * props.durationMs;
  }

  createEffect(() => {
    size();
    const peaks = props.peaks;
    const duration = props.durationMs;
    const position = props.positionMs;
    const reg = region();
    const bpm = props.gridBpm;
    const gridKey = props.gridOffset + props.gridBeats + props.gridDownbeat;
    if (Number.isNaN(gridKey)) return;
    const el = canvas();
    if (!el || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    if (width === 0) return;
    el.width = Math.floor(width * dpr);
    el.height = Math.floor(HEIGHT * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = token("--color-bg");
    ctx.fillRect(0, 0, width, HEIGHT);

    if (reg.on) {
      const x0 = (reg.start / duration) * width;
      const x1 = (reg.end / duration) * width;
      ctx.fillStyle = token("--color-accent-soft");
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), HEIGHT);
    }

    const lines = bpm > 0 ? gridLines(grid(), duration) : [];
    const spacing = lines.length > 1 ? ((lines[1].ms - lines[0].ms) / duration) * width : 0;
    for (const line of lines) {
      if (!line.bar && spacing < 7) continue;
      const x = Math.round((line.ms / duration) * width) + 0.5;
      ctx.strokeStyle = line.bar ? token("--color-border-strong") : token("--color-border");
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }

    const mid = HEIGHT / 2;
    const pairs = Math.floor(peaks.length / 2);
    let top = 0.0001;
    for (let i = 0; i < peaks.length; i++) top = Math.max(top, Math.abs(peaks[i]));
    const scale = (HEIGHT / 2 - 6) / top;
    const playedX = (position / duration) * width;
    for (let x = 0; x < width; x++) {
      const bucket = Math.min(pairs - 1, Math.floor((x / width) * pairs));
      const lo = peaks[bucket * 2] * scale;
      const hi = peaks[bucket * 2 + 1] * scale;
      ctx.fillStyle = x < playedX ? token("--color-accent") : token("--color-text-dim");
      const y0 = mid - Math.max(hi, 0.5);
      const y1 = mid - Math.min(lo, -0.5);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    if (reg.on) {
      ctx.fillStyle = token("--color-accent");
      for (const ms of [reg.start, reg.end]) {
        const x = Math.round((ms / duration) * width);
        ctx.fillRect(x - 1, 0, 3, HEIGHT);
        ctx.fillRect(x - 5, 0, 11, 10);
        ctx.fillRect(x - 5, HEIGHT - 10, 11, 10);
      }
    }

    ctx.fillStyle = token("--color-text");
    ctx.fillRect(Math.round(playedX), 0, 1, HEIGHT);
  });

  function pointerX(e: PointerEvent): number {
    const el = canvas();
    if (!el) return 0;
    return e.clientX - el.getBoundingClientRect().left;
  }

  function onDown(e: PointerEvent) {
    const el = canvas();
    if (!el || props.durationMs <= 0) return;
    el.setPointerCapture(e.pointerId);
    const width = el.clientWidth;
    const x = pointerX(e);
    const reg = region();
    const handle = hitHandle(x, (reg.start / props.durationMs) * width, (reg.end / props.durationMs) * width, reg.on, GRAB);
    drag.startX = x;
    drag.moved = false;
    const mode: SnapMode = e.altKey ? "off" : props.snap;
    if (handle) {
      drag.mode = handle;
      setDragStart(reg.start);
      setDragEnd(reg.end);
    } else {
      drag.mode = "select";
      drag.anchor = snapTime(toMs(x, width), grid(), mode, props.durationMs);
    }
  }

  function onMove(e: PointerEvent) {
    const el = canvas();
    if (!el || props.durationMs <= 0) return;
    const width = el.clientWidth;
    const x = pointerX(e);
    const reg = region();
    if (drag.mode === "none") {
      const near = hitHandle(x, (reg.start / props.durationMs) * width, (reg.end / props.durationMs) * width, reg.on, GRAB);
      el.style.cursor = near ? "col-resize" : "crosshair";
      return;
    }
    const mode: SnapMode = e.altKey ? "off" : props.snap;
    const ms = snapTime(toMs(x, width), grid(), mode, props.durationMs);
    if (Math.abs(x - drag.startX) > 4) drag.moved = true;
    if (drag.mode === "select" && drag.moved) {
      const r = orderRegion(drag.anchor, ms);
      setDragStart(r.start);
      setDragEnd(r.end);
    } else if (drag.mode === "start") {
      setDragStart(Math.min(ms, dragEnd() - MIN_LOOP_MS));
    } else if (drag.mode === "end") {
      setDragEnd(Math.max(ms, dragStart() + MIN_LOOP_MS));
    }
  }

  function onUp(e: PointerEvent) {
    const el = canvas();
    if (!el) return;
    el.releasePointerCapture(e.pointerId);
    const width = el.clientWidth;
    const mode = drag.mode;
    drag.mode = "none";
    if (mode === "none") return;
    const s = dragStart();
    const en = dragEnd();
    setDragStart(-1);
    setDragEnd(-1);
    if (mode === "select" && !drag.moved) {
      const snapMode: SnapMode = e.altKey ? "off" : props.snap;
      props.onSeek(snapTime(toMs(pointerX(e), width), grid(), snapMode, props.durationMs));
      return;
    }
    if (s >= 0 && en - s >= MIN_LOOP_MS) props.onLoop(s, en);
  }

  function onKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 5000 : 1000;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      props.onSeek(Math.min(props.durationMs, props.positionMs + step));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      props.onSeek(Math.max(0, props.positionMs - step));
    }
  }

  onMount(() => {
    const el = canvas();
    if (!el) return;
    el.style.cursor = "crosshair";
    const observer = new ResizeObserver(() => setSize(el.clientWidth));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
    setSize(el.clientWidth);
  });

  return (
    <canvas
      id="waveform"
      class="waveform"
      tabindex={0}
      role="img"
      aria-label="Song waveform. Drag to choose a loop, click to move the playhead, arrow keys to step."
      style={"height:" + HEIGHT + "px"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={onKey}
    />
  );
}
