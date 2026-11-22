import { createSignal, createEffect } from "@krate/runtime";
import { Engine } from "../../../api/host.go";
import { emptyEngine } from "../../lib/engine";
import type { EngineStatus } from "../../lib/types";
import { StatusDot } from "../ui/status-dot";
import { stateLabel, stateTone } from "../../lib/format";

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });

  return (
    <aside class="sidebar" aria-label="Primary">
      <div class="sidebar-head">
        <div class="brand">
          <span class="brand-mark">PM</span>
          <span class="brand-name">PracticeMusic</span>
        </div>
        <button
          class="krate-button krate-button-ghost krate-button-icon collapse-toggle"
          type="button"
          aria-label="Toggle sidebar"
          onClick={props.onToggle}
        >
          <Icon name="lucide:panel-left" />
        </button>
      </div>
      <nav class="sidebar-nav">
        <span class="nav-label">Workstation</span>
        <Link class="nav-link" href="/" onClick={props.onNavigate}>
          <Icon name="lucide:activity" />
          <span class="nav-text">Overview</span>
        </Link>
        <Link class="nav-link" href="/library" onClick={props.onNavigate}>
          <Icon name="lucide:library" />
          <span class="nav-text">Library</span>
        </Link>
        <Link class="nav-link" href="/player" onClick={props.onNavigate}>
          <Icon name="lucide:audio-waveform" />
          <span class="nav-text">Player</span>
        </Link>
        <Link class="nav-link" href="/mixer" onClick={props.onNavigate}>
          <Icon name="lucide:sliders-vertical" />
          <span class="nav-text">Mixer</span>
        </Link>
        <Link class="nav-link" href="/metronome" onClick={props.onNavigate}>
          <Icon name="lucide:metronome" />
          <span class="nav-text">Metronome</span>
        </Link>
        <Link class="nav-link" href="/downloads" onClick={props.onNavigate}>
          <Icon name="lucide:download" />
          <span class="nav-text">Downloads</span>
        </Link>
        <Link class="nav-link" href="/browser" onClick={props.onNavigate}>
          <Icon name="lucide:globe" />
          <span class="nav-text">Browser</span>
        </Link>
        <Link class="nav-link" href="/latency" onClick={props.onNavigate}>
          <Icon name="lucide:timer" />
          <span class="nav-text">Latency</span>
        </Link>
      </nav>
      <div class="sidebar-foot">
        <StatusDot tone={stateTone(engine().state)} label={stateLabel(engine().state)} />
        <div class="sidebar-foot-text">
          <span class="sidebar-foot-title">Audio engine</span>
          <span class="sidebar-foot-sub">{stateLabel(engine().state)}</span>
        </div>
        <Link
          class="krate-button krate-button-ghost krate-button-icon"
          href="/settings"
          aria-label="Settings"
          onClick={props.onNavigate}
        >
          <Icon name="lucide:settings" />
        </Link>
      </div>
    </aside>
  );
}
