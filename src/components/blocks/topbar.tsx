import { createSignal } from "@krate/runtime";
import type { PanelKey, PanelSet } from "../../lib/workspace";

export interface TopbarProps {
  panels?: PanelSet;
  onToggle?: (key: PanelKey) => void;
  onReset?: () => void;
}

export function Topbar(props: TopbarProps) {
  const [menu, setMenu] = createSignal(false);

  const on = (key: PanelKey) => (props.panels ? props.panels[key] : false);
  const toggle = (key: PanelKey) => {
    if (props.onToggle) props.onToggle(key);
    setMenu(false);
  };
  const reset = () => {
    if (props.onReset) props.onReset();
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
        <button class="panel-toggle reset-toggle" type="button" title="Put the panels back where they started" onClick={reset}>
          <Icon name="lucide:layout-template" />
          <span>Reset layout</span>
        </button>
      </nav>

      <Link class="krate-button krate-button-secondary krate-button-sm back-link" href="/" showIf={!props.panels}>
        <Icon name="lucide:arrow-left" />
        Workspace
      </Link>

      <div class="topbar-tools">
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
