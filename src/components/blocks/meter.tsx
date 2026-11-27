import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { AudioStream } from "../../../api/audio.go";
import { MeterStream, ResetMeters } from "../../../api/session.go";
import { LiveText } from "../ui/live-text";
import { meterFraction, peakText, peakZone, toDb } from "../../lib/mixer";
import { LANE_WIDTH, drawLane } from "../../lib/meter-draw";
import { currentPrefs } from "../../lib/prefs";

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

const quiet: Level = { l: 0, r: 0, clip: false, gr: 0 };

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Meter(props: MeterProps) {
  const [size, setSize] = createSignal(0);
  const [level, setLevel] = createSignal<Level>(quiet);
  const hold = { value: 0, at: 0 };
  const [expired, setExpired] = createSignal(0);
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
    expired();
    const lv = level();
    const el = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!el) return;
    const height = el.clientHeight;
    if (height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.floor(LANE_WIDTH * dpr);
    el.height = Math.floor(height * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    const fraction = meterFraction(Math.max(lv.l, lv.r));
    const holdMs = currentPrefs().peakHoldMs;
    if (holdMs === 0) {
      hold.value = 0;
    } else if (fraction >= hold.value || now - hold.at >= holdMs) {
      hold.value = fraction;
      hold.at = now;
    }
    if (hold.value > fraction) {
      const timer = window.setTimeout(() => setExpired(expired() + 1), Math.max(0, holdMs - (now - hold.at)) + 16);
      onCleanup(() => window.clearTimeout(timer));
    }
    drawLane(
      ctx,
      height,
      {
        level: fraction,
        hold: hold.value,
        clip: lv.clip,
        reduction: currentPrefs().reductionBars && lv.gr > 0.1 ? lv.gr / 24 : 0,
      },
      token,
    );
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
      <canvas id={canvasId} class="meter" role="img" aria-label={props.label + " level"} />
    </div>
  );
}

export interface PeakReadoutProps {
  which: string;
}

export function PeakReadout(props: PeakReadoutProps) {
  const [text, setText] = createSignal("-inf");
  const [hot, setHot] = createSignal(false);
  const [zone, setZone] = createSignal("none");
  const state = { peak: 0, clip: false };

  createEffect(() => {
    const running = AudioStream()?.running;
    const frame = MeterStream();
    if (!running || !frame) return;
    const lv: Level =
      props.which === "main"
        ? frame.main
        : props.which === "monitor"
          ? frame.monitor
          : frame.strips[Number(props.which)] || quiet;
    if (state.clip && !lv.clip) state.peak = 0;
    state.clip = lv.clip;
    state.peak = Math.max(state.peak, lv.l, lv.r);
    setText(peakText(state.peak));
    setHot(toDb(state.peak) > 0);
    setZone(peakZone(state.peak));
  });

  return (
    <button
      class="strip-peak mono"
      type="button"
      data-hot={hot() ? "true" : "false"}
      data-zone={zone()}
      aria-label="Peak level. Click to reset."
      data-tip="Peak hold. Click to reset."
      onClick={() => {
        state.peak = 0;
        setText("-inf");
        setHot(false);
        setZone("none");
        ResetMeters().catch(() => undefined);
      }}
    >
      {text()}
    </button>
  );
}

export function GainReduction() {
  const [text, setText] = createSignal("0.0");
  const [active, setActive] = createSignal(false);

  createEffect(() => {
    const running = AudioStream()?.running;
    const frame = MeterStream();
    const gr = running && frame ? frame.main.gr : 0;
    setText(gr.toFixed(1));
    setActive(gr >= 0.1);
  });

  return (
    <div class="gr-readout" data-active={active() ? "true" : "false"} data-tip="Limiter gain reduction in dB">
      <span class="gr-label">GR</span>
      <LiveText class="gr-value mono" text={text()} />
      <span class="gr-unit">dB</span>
    </div>
  );
}
