import { createSignal, createEffect } from "@krate/runtime";
import { Engine } from "../../../api/host.go";
import { emptyEngine } from "../../lib/engine";
import type { EngineStatus } from "../../lib/types";
import { StatusDot } from "../ui/status-dot";
import { LiveText } from "../ui/live-text";
import { stateLabel, stateTone } from "../../lib/format";

export interface AppbarProps {
  onToggle: () => void;
  onNavigate: () => void;
}

export function Appbar(props: AppbarProps) {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  const [label, setLabel] = createSignal("Connecting");
  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });
  createEffect(() => {
    setLabel(stateLabel(engine().state));
  });

  return (
    <header class="appbar">
      <Link class="brand" href="/" onClick={props.onNavigate}>
        <span class="brand-mark">
          <Icon name="lucide:drum" />
        </span>
        <span class="brand-name">PracticeMusic</span>
      </Link>

      <nav class="tabs" aria-label="Primary">
        <Link class="tab" data-hue="home" href="/" onClick={props.onNavigate}>
          <Icon name="lucide:house" />
          <span class="tab-text">Home</span>
        </Link>
        <Link class="tab" data-hue="library" href="/library" onClick={props.onNavigate}>
          <Icon name="lucide:library-big" />
          <span class="tab-text">Library</span>
        </Link>
        <Link class="tab" data-hue="player" href="/player" onClick={props.onNavigate}>
          <Icon name="lucide:audio-waveform" />
          <span class="tab-text">Player</span>
        </Link>
        <Link class="tab" data-hue="mixer" href="/mixer" onClick={props.onNavigate}>
          <Icon name="lucide:sliders-vertical" />
          <span class="tab-text">Mixer</span>
        </Link>
        <Link class="tab" data-hue="metronome" href="/metronome" onClick={props.onNavigate}>
          <Icon name="lucide:metronome" />
          <span class="tab-text">Metronome</span>
        </Link>
        <Link class="tab" data-hue="browser" href="/browser" onClick={props.onNavigate}>
          <Icon name="lucide:globe" />
          <span class="tab-text">Browser</span>
        </Link>
        <Link class="tab" data-hue="downloads" href="/downloads" onClick={props.onNavigate}>
          <Icon name="lucide:download" />
          <span class="tab-text">Downloads</span>
        </Link>
      </nav>

      <div class="appbar-tools">
        <Link class="engine-chip" href="/settings" aria-label="Audio engine status" onClick={props.onNavigate}>
          <StatusDot tone={stateTone(engine().state)} label={label()} />
          <LiveText class="engine-label" text={label()} />
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/latency" aria-label="Latency" onClick={props.onNavigate}>
          <Icon name="lucide:timer" />
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/settings" aria-label="Settings" onClick={props.onNavigate}>
          <Icon name="lucide:settings" />
        </Link>
        <button class="krate-button krate-button-ghost krate-button-icon menu-toggle" type="button" aria-label="Menu" onClick={props.onToggle}>
          <Icon name="lucide:menu" />
        </button>
      </div>
    </header>
  );
}
