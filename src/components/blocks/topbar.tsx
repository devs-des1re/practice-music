import { createSignal, createEffect } from "@krate/runtime";
import { Engine } from "../../../api/host.go";
import { emptyEngine } from "../../lib/engine";
import type { EngineStatus } from "../../lib/types";
import type { PanelKey, PanelSet } from "../../lib/workspace";
import { StatusDot } from "../ui/status-dot";
import { LiveText } from "../ui/live-text";
import { stateLabel, stateTone } from "../../lib/format";

export interface TopbarProps {
  panels?: PanelSet;
  onToggle?: (key: PanelKey) => void;
}

export function Topbar(props: TopbarProps) {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  const [label, setLabel] = createSignal("Connecting");
  const [menu, setMenu] = createSignal(false);
  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });
  createEffect(() => {
    setLabel(stateLabel(engine().state));
  });

  const on = (key: PanelKey) => (props.panels ? props.panels[key] : false);
  const toggle = (key: PanelKey) => {
    if (props.onToggle) props.onToggle(key);
    setMenu(false);
  };

  return (
    <header class="topbar" data-menu={menu() ? "open" : "closed"}>
      <Link class="brand" href="/">
        <span class="brand-mark">
          <Icon name="lucide:drum" />
        </span>
        <span class="brand-name">PracticeMusic</span>
      </Link>

      <nav class="panel-toggles" aria-label="Panels" showIf={!!props.panels}>
        <button class="panel-toggle" type="button" data-hue="library" aria-pressed={on("library") ? "true" : "false"} onClick={() => toggle("library")}>
          <Icon name="lucide:library-big" />
          <span>Library</span>
        </button>
        <button class="panel-toggle" type="button" data-hue="mixer" aria-pressed={on("mixer") ? "true" : "false"} onClick={() => toggle("mixer")}>
          <Icon name="lucide:sliders-vertical" />
          <span>Mixer</span>
        </button>
        <button class="panel-toggle" type="button" data-hue="downloads" aria-pressed={on("downloads") ? "true" : "false"} onClick={() => toggle("downloads")}>
          <Icon name="lucide:download" />
          <span>Downloads</span>
        </button>
        <button class="panel-toggle" type="button" data-hue="browser" aria-pressed={on("browser") ? "true" : "false"} onClick={() => toggle("browser")}>
          <Icon name="lucide:globe" />
          <span>Browser</span>
        </button>
      </nav>

      <Link class="krate-button krate-button-secondary krate-button-sm back-link" href="/" showIf={!props.panels}>
        <Icon name="lucide:arrow-left" />
        Workspace
      </Link>

      <div class="topbar-tools">
        <Link class="engine-chip" href="/settings" aria-label="Audio engine status">
          <StatusDot tone={stateTone(engine().state)} label={label()} />
          <LiveText class="engine-label" text={label()} />
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/latency" aria-label="Latency" title="Latency">
          <Icon name="lucide:timer" />
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/settings" aria-label="Settings" title="Settings">
          <Icon name="lucide:settings" />
        </Link>
        <button class="krate-button krate-button-ghost krate-button-icon menu-toggle" type="button" aria-label="Menu" showIf={!!props.panels} onClick={() => setMenu(!menu())}>
          <Icon name="lucide:menu" />
        </button>
      </div>
    </header>
  );
}
