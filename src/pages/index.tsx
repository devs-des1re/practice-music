import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { Topbar } from "../components/blocks/topbar";
import { ShortcutsDialog } from "../components/blocks/shortcuts-dialog";
import { PlayerDeck } from "../components/blocks/player-deck";
import { MetronomeDeck } from "../components/blocks/metronome-deck";
import { LibraryPanel } from "../components/blocks/library-panel";
import { MixerPanel } from "../components/blocks/mixer-panel";
import { DownloadsPanel } from "../components/blocks/downloads-panel";
import { BrowserPanel } from "../components/blocks/browser-panel";
import {
  ALL_PANELS,
  PANEL_TITLES,
  add,
  clampRatio,
  defaultTree,
  geometry,
  hintRect,
  move,
  normalise,
  parseTree,
  presetTree,
  remove,
  withRatio,
  zoneAt,
  type GutterGeo,
  type Node,
  type PanelId,
  type PresetName,
  type Zone,
} from "../lib/layout";
import { defaultPanels, isTyping, loadPanels, savePanels, type PanelKey, type PanelSet } from "../lib/workspace";

const LAYOUT_KEY = "pm.workspace.layout";
const FOLD_KEY = "pm.workspace.collapsed";
const MIN_WIDTH = 240;
const MIN_HEIGHT = 150;
const STACK_WIDTH = 1000;
const MOVE_THRESHOLD = 6;
const GUTTER = 8;

interface GutterView {
  path: string;
  dir: string;
  style: string;
  geo: GutterGeo;
}

interface DragState {
  id: PanelId;
  x: number;
  y: number;
  live: boolean;
  target: PanelId | null;
  zone: Zone;
}

function visibleIn(set: PanelSet) {
  return (id: PanelId) => id === "player" || id === "metronome" || set[id];
}

function pct(n: number): string {
  return (n * 100).toFixed(4) + "%";
}

function stageBox(): DOMRect | null {
  const el = document.querySelector(".ws-stage");
  return el ? el.getBoundingClientRect() : null;
}

function readSaved(): Node | null {
  try {
    return parseTree(JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"));
  } catch {
    return null;
  }
}

function readFolds(): PanelId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLD_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((id): id is PanelId => (ALL_PANELS as string[]).includes(id)) : [];
  } catch {
    return [];
  }
}

function cellOf(id: string): HTMLElement | null {
  return document.querySelector('[data-tile="' + id + '"]');
}

export default function Workspace() {
  const [panels, setPanels] = createSignal<PanelSet>(defaultPanels);
  const [layout, setLayout] = createSignal<Node>(defaultTree(visibleIn(defaultPanels)));
  const [gutters, setGutters] = createSignal<GutterView[]>([]);
  const [ready, setReady] = createSignal(false);
  const [dragId, setDragId] = createSignal("");
  const [chipTitle, setChipTitle] = createSignal("");
  const [hintOn, setHintOn] = createSignal(false);
  const [resizePath, setResizePath] = createSignal("");
  const [shortcuts, setShortcuts] = createSignal(false);
  const [folds, setFolds] = createSignal<PanelId[]>([]);
  const [stage, setStage] = createSignal({ w: 0, h: 0 });

  let drag: DragState | null = null;
  let resizing: GutterGeo | null = null;

  onMount(() => {
    const set = loadPanels();
    setPanels(set);
    setLayout(normalise(readSaved(), visibleIn(set)));
    setFolds(readFolds());
    setReady(true);
    const el = document.querySelector(".ws-stage");
    if (!el) return;
    const observer = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const tree = layout();
    if (typeof document === "undefined") return;
    const folded = folds();
    const geo = geometry(tree, { collapsed: new Set(folded), stage: stage() });
    for (const id of ALL_PANELS) {
      const el = cellOf(id);
      const r = geo.rects[id];
      if (!el || !r) continue;
      el.style.left = pct(r.x);
      el.style.top = pct(r.y);
      el.style.width = pct(r.w);
      el.style.height = pct(r.h);
      el.dataset.collapsed = geo.folds[id] || "";
      el.dataset.folded = folded.includes(id) ? "true" : "false";
    }
    setGutters(
      geo.gutters
        .filter((g) => !g.locked)
        .map((g) => {
        const style =
          g.dir === "row"
            ? "left:calc(" + pct(g.area.x + g.area.w * g.ratio) + " - " + GUTTER / 2 + "px);top:" + pct(g.area.y) + ";width:" + GUTTER + "px;height:" + pct(g.area.h)
            : "top:calc(" + pct(g.area.y + g.area.h * g.ratio) + " - " + GUTTER / 2 + "px);left:" + pct(g.area.x) + ";height:" + GUTTER + "px;width:" + pct(g.area.w);
        return { path: g.path, dir: g.dir, style, geo: g };
      }),
    );
    if (!ready()) return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(tree));
      localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
    } catch {
      return;
    }
  });

  createEffect(() => {
    const id = dragId();
    if (typeof document === "undefined") return;
    for (const p of ALL_PANELS) {
      const el = cellOf(p);
      if (el) el.dataset.dragged = id === p ? "true" : "false";
    }
  });

  function setPanel(key: PanelKey, value: boolean) {
    const next = { ...panels(), [key]: value };
    setPanels(next);
    savePanels(next);
    setLayout(value ? add(layout(), key) : (remove(layout(), key) ?? defaultTree(visibleIn(next))));
  }

  function resetLayout() {
    setFolds([]);
    setLayout(defaultTree(visibleIn(panels())));
  }

  function toggleFold(id: PanelId) {
    setFolds(folds().includes(id) ? folds().filter((x) => x !== id) : [...folds(), id]);
  }

  function onStageClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const button = target ? target.closest("[data-fold]") : null;
    if (!button) return;
    const cell = button.closest("[data-tile]") as HTMLElement | null;
    if (cell && cell.dataset.tile) toggleFold(cell.dataset.tile as PanelId);
  }

  function applyPreset(name: string) {
    const next = { ...panels(), library: true, mixer: true };
    setPanels(next);
    savePanels(next);
    setFolds([]);
    setLayout(presetTree(name as PresetName, visibleIn(next)));
  }

  function startResize(e: PointerEvent, g: GutterGeo) {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = g;
    setResizePath(g.path);
  }

  function onStageDown(e: PointerEvent) {
    if (e.button !== 0 || e.pointerType === "touch") return;
    if (window.innerWidth <= STACK_WIDTH) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const handle = target.closest("[data-drag]");
    if (!handle || target.closest("button, input, select, textarea, a, label")) return;
    const cell = handle.closest("[data-tile]") as HTMLElement | null;
    if (!cell || !cell.dataset.tile) return;
    drag = { id: cell.dataset.tile as PanelId, x: e.clientX, y: e.clientY, live: false, target: null, zone: "center" };
  }

  function placeChip(x: number, y: number) {
    const chip = document.querySelector(".drag-chip") as HTMLElement | null;
    if (!chip) return;
    chip.style.left = x + 14 + "px";
    chip.style.top = y + 14 + "px";
  }

  function placeHint(rect: { x: number; y: number; w: number; h: number } | null) {
    const el = document.querySelector(".drop-hint") as HTMLElement | null;
    if (!el) return;
    if (!rect) {
      setHintOn(false);
      return;
    }
    el.style.left = rect.x + 4 + "px";
    el.style.top = rect.y + 4 + "px";
    el.style.width = Math.max(0, rect.w - 8) + "px";
    el.style.height = Math.max(0, rect.h - 8) + "px";
    setHintOn(true);
  }

  function onMove(e: PointerEvent) {
    if (resizing) {
      const box = stageBox();
      if (!box) return;
      const g = resizing;
      const row = g.dir === "row";
      const size = row ? box.width * g.area.w : box.height * g.area.h;
      const origin = row ? box.left + box.width * g.area.x : box.top + box.height * g.area.y;
      const pos = row ? e.clientX : e.clientY;
      setLayout(withRatio(layout(), g.path, clampRatio((pos - origin) / size, size, row ? MIN_WIDTH : MIN_HEIGHT)));
      return;
    }
    if (!drag) return;
    if (!drag.live) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < MOVE_THRESHOLD) return;
      drag.live = true;
      setChipTitle(PANEL_TITLES[drag.id]);
      setDragId(drag.id);
    }
    placeChip(e.clientX, e.clientY);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under ? (under.closest("[data-tile]") as HTMLElement | null) : null;
    const target = cell && cell.dataset.tile ? (cell.dataset.tile as PanelId) : null;
    if (!cell || !target || target === drag.id) {
      drag.target = null;
      placeHint(null);
      return;
    }
    const r = cell.getBoundingClientRect();
    const zone = zoneAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    drag.target = target;
    drag.zone = zone;
    placeHint(hintRect({ x: r.left, y: r.top, w: r.width, h: r.height }, zone));
  }

  function finish(commit: boolean) {
    if (resizing) {
      resizing = null;
      setResizePath("");
      return;
    }
    const d = drag;
    drag = null;
    if (!d || !d.live) return;
    setDragId("");
    placeHint(null);
    if (commit && d.target) setLayout(move(layout(), d.id, d.target, d.zone));
  }

  onMount(() => {
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const panel: Record<string, PanelKey> = { "1": "library", "2": "mixer", "3": "downloads", "4": "browser" };
        const target = panel[e.key];
        if (target) {
          e.preventDefault();
          setPanel(target, !panels()[target]);
        }
        return;
      }
      if (e.key === "?" && !isTyping(e)) {
        e.preventDefault();
        setShortcuts(!shortcuts());
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    onCleanup(() => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    });
  });

  return (
    <div class="screen">
      <Topbar panels={panels()} onToggle={(key) => setPanel(key, !panels()[key])} onPreset={applyPreset} onReset={resetLayout} onShortcuts={() => setShortcuts(true)} />
      <main class="ws">
        <div class="ws-stage" data-dragging={dragId() ? "true" : "false"} data-resizing={resizePath() ? "true" : "false"} onPointerDown={onStageDown} onClick={onStageClick}>
          <div class="cell" data-tile="player">
            <PlayerDeck onShowLibrary={() => setPanel("library", true)} />
          </div>
          <div class="cell" data-tile="metronome">
            <MetronomeDeck />
          </div>
          <div class="cell" data-tile="library" showIf={panels().library}>
            <LibraryPanel />
          </div>
          <div class="cell" data-tile="mixer" showIf={panels().mixer}>
            <MixerPanel />
          </div>
          <div class="cell" data-tile="downloads" showIf={panels().downloads}>
            <DownloadsPanel />
          </div>
          <div class="cell" data-tile="browser" showIf={panels().browser}>
            <BrowserPanel open={panels().browser} />
          </div>
          {gutters().map((g) => (
            <div
              class="gutter"
              key={g.path}
              data-dir={g.dir}
              data-active={resizePath() === g.path ? "true" : "false"}
              style={g.style}
              role="separator"
              aria-label="Drag to resize"
              onPointerDown={(e: PointerEvent) => startResize(e, g.geo)}
            />
          ))}
        </div>
      </main>
      <ShortcutsDialog open={shortcuts()} onClose={() => setShortcuts(false)} />
      <div class="drop-hint" data-on={hintOn() ? "true" : "false"} />
      <div class="drag-chip" data-on={dragId() ? "true" : "false"}>
        {chipTitle()}
      </div>
    </div>
  );
}
