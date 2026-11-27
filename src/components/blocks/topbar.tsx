import { createSignal } from "@krate/runtime";
import { Menu } from "../ui/menu";
import type { PanelKey, PanelSet } from "../../lib/workspace";

export interface TopbarProps {
  panels?: PanelSet;
  onToggle?: (key: PanelKey) => void;
  onPreset?: (name: string) => void;
  onReset?: () => void;
  onShortcuts?: () => void;
}

export function Topbar(props: TopbarProps) {
  const [menu, setMenu] = createSignal(false);
  const [layoutOpen, setLayoutOpen] = createSignal(false);
  const [layoutX, setLayoutX] = createSignal(0);
  const [layoutY, setLayoutY] = createSignal(0);

  const toggle = (key: PanelKey) => {
    if (props.onToggle) props.onToggle(key);
    setMenu(false);
  };
  const preset = (name: string) => {
    if (props.onPreset) props.onPreset(name);
  };
  const reset = () => {
    if (props.onReset) props.onReset();
  };
  const shortcuts = () => {
    if (props.onShortcuts) props.onShortcuts();
  };
  const openLayout = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLayoutX(r.left);
    setLayoutY(r.bottom + 2);
    setLayoutOpen(!layoutOpen());
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

      <nav class="nav-tabs" aria-label="Panels" showIf={!!props.panels}>
        <button class="tab" type="button" aria-pressed={props.panels && props.panels.library ? "true" : "false"} data-tip="Show or hide the library" data-keys="Alt+1" onClick={() => toggle("library")}>
          <Icon name="lucide:library-big" />
          <span>Library</span>
        </button>
        <button class="tab" type="button" aria-pressed={props.panels && props.panels.mixer ? "true" : "false"} data-tip="Show or hide the mixer" data-keys="Alt+2" onClick={() => toggle("mixer")}>
          <Icon name="lucide:sliders-vertical" />
          <span>Mixer</span>
        </button>
        <button class="tab" type="button" aria-pressed={props.panels && props.panels.downloads ? "true" : "false"} data-tip="Show or hide downloads" data-keys="Alt+3" onClick={() => toggle("downloads")}>
          <Icon name="lucide:download" />
          <span>Downloads</span>
        </button>
        <button class="tab" type="button" aria-pressed={props.panels && props.panels.browser ? "true" : "false"} data-tip="Show or hide the browser" data-keys="Alt+4" onClick={() => toggle("browser")}>
          <Icon name="lucide:globe" />
          <span>Browser</span>
        </button>
      </nav>

      <Link class="krate-button krate-button-secondary krate-button-sm back-link" href="/" showIf={!props.panels}>
        <Icon name="lucide:arrow-left" />
        Workspace
      </Link>

      <div class="topbar-spacer" />

      <div class="topbar-tools">
        <button class="krate-button krate-button-ghost krate-button-sm" type="button" aria-haspopup="menu" showIf={!!props.panels} data-tip="Workspace layouts" onClick={openLayout}>
          <Icon name="lucide:layout-template" />
          Layout
          <Icon name="lucide:chevron-down" />
        </button>
        <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Keyboard shortcuts" showIf={!!props.panels} data-tip="Keyboard shortcuts" data-keys="?" onClick={shortcuts}>
          <Icon name="lucide:keyboard" />
        </button>
        <Link class="krate-button krate-button-ghost krate-button-sm drum-link" href="/drums" aria-label="MIDI drums" data-tip="MIDI drums and kit settings">
          <Icon name="lucide:drum" />
          <span>Drums</span>
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/latency" aria-label="Latency" data-tip="Latency tools">
          <Icon name="lucide:timer" />
        </Link>
        <Link class="krate-button krate-button-ghost krate-button-icon" href="/settings" aria-label="Settings" data-tip="Settings">
          <Icon name="lucide:settings" />
        </Link>
        <button class="krate-button krate-button-ghost krate-button-icon menu-toggle" type="button" aria-label="Menu" showIf={!!props.panels} onClick={() => setMenu(!menu())}>
          <Icon name="lucide:menu" />
        </button>
      </div>

      <Menu
        id="layout-menu"
        open={layoutOpen()}
        x={layoutX()}
        y={layoutY()}
        onClose={() => setLayoutOpen(false)}
        items={[
          { label: "Practice layout", onSelect: () => preset("practice") },
          { label: "Mixing layout", onSelect: () => preset("mixing") },
          { label: "", separator: true },
          { label: "Reset panels", onSelect: reset },
        ]}
      />
    </header>
  );
}
