import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { snapTime, gridLines, hitHandle, orderRegion, type GridInfo, type SnapMode } from "../../lib/waveform";
import { LANE, RULER, drawWaveform, type Flag, type WaveMarker } from "../../lib/wave-draw";

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
  markers: WaveMarker[];
  onLoop: (start: number, end: number) => void;
  onMarker: (index: number) => void;
}

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
  let flags: Flag[] = [];

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
    const gridKey = props.gridOffset + props.gridBeats + props.gridDownbeat;
    if (Number.isNaN(gridKey)) return;
    const el = canvas();
    if (!el || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const HEIGHT = el.clientHeight;
    if (width === 0 || HEIGHT === 0) return;
    el.width = Math.floor(width * dpr);
    el.height = Math.floor(HEIGHT * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    flags = drawWaveform(
      ctx,
      width,
      HEIGHT,
      { peaks, duration, position, region: reg, lines: gridLines(grid(), duration), markers: props.markers },
      token,
    );
  });

  function pointerX(e: PointerEvent): number {
    const el = canvas();
    if (!el) return 0;
    return e.clientX - el.getBoundingClientRect().left;
  }

  function pointerY(e: PointerEvent): number {
    const el = canvas();
    if (!el) return 0;
    return e.clientY - el.getBoundingClientRect().top;
  }

  function onDown(e: PointerEvent) {
    const el = canvas();
    if (!el || props.durationMs <= 0) return;
    el.setPointerCapture(e.pointerId);
    const width = el.clientWidth;
    const x = pointerX(e);
    const y = pointerY(e);
    if (props.markers.length > 0 && y >= RULER && y < RULER + LANE) {
      const flag = flags.find((f) => x >= f.x0 && x <= f.x1);
      if (flag) {
        props.onMarker(flag.index);
        return;
      }
    }
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
      const py = pointerY(e);
      const overFlag = props.markers.length > 0 && py >= RULER && py < RULER + LANE && flags.some((f) => x >= f.x0 && x <= f.x1);
      el.style.cursor = overFlag ? "pointer" : near ? "col-resize" : "crosshair";
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
    const observer = new ResizeObserver(() => setSize(el.clientWidth * 10000 + el.clientHeight));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
    setSize(el.clientWidth * 10000 + el.clientHeight);
  });

  return (
    <div class="wave-box">
      <canvas
        id="waveform"
        class="waveform"
        tabindex={0}
        role="img"
        aria-label="Song waveform. Drag to choose a loop, click to move the playhead, arrow keys to step."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKey}
      />
    </div>
  );
}
