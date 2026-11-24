export type PanelId = "player" | "metronome" | "library" | "mixer" | "downloads" | "browser";

export type Dir = "row" | "col";

export type Zone = "left" | "right" | "top" | "bottom" | "center";

export interface Leaf {
  kind: "leaf";
  id: PanelId;
}

export interface Split {
  kind: "split";
  dir: Dir;
  ratio: number;
  a: Node;
  b: Node;
}

export type Node = Leaf | Split;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GutterGeo {
  path: string;
  dir: Dir;
  ratio: number;
  area: Rect;
  locked: boolean;
}

export type Fold = "bar" | "rail";

export interface GeoOptions {
  collapsed?: ReadonlySet<PanelId>;
  stage?: { w: number; h: number };
  bar?: number;
  rail?: number;
}

export interface Geometry {
  rects: Partial<Record<PanelId, Rect>>;
  gutters: GutterGeo[];
  folds: Partial<Record<PanelId, Fold>>;
}

export const ALL_PANELS: PanelId[] = ["player", "metronome", "library", "mixer", "downloads", "browser"];

export const LOWER_PANELS: PanelId[] = ["library", "mixer", "downloads", "browser"];

export const FIXED_PANELS: PanelId[] = ["player", "metronome"];

export const PANEL_TITLES: Record<PanelId, string> = {
  player: "Player",
  metronome: "Metronome",
  library: "Library",
  mixer: "Mixer",
  downloads: "Downloads",
  browser: "Browser",
};

export const MIN_RATIO = 0.08;

const leaf = (id: PanelId): Leaf => ({ kind: "leaf", id });

const split = (dir: Dir, ratio: number, a: Node, b: Node): Split => ({ kind: "split", dir, ratio, a, b });

export function leaves(node: Node): PanelId[] {
  if (node.kind === "leaf") return [node.id];
  return [...leaves(node.a), ...leaves(node.b)];
}

export function has(node: Node | null, id: PanelId): boolean {
  return node !== null && leaves(node).includes(id);
}

function chain(ids: PanelId[]): Node {
  if (ids.length === 1) return leaf(ids[0]);
  return split("row", 1 / ids.length, leaf(ids[0]), chain(ids.slice(1)));
}

function withLead(lead: PanelId, ratio: number, ids: PanelId[]): Node {
  const rest = ids.filter((id) => id !== lead);
  if (!ids.includes(lead) || rest.length === 0) return chain(ids);
  return split("row", ratio, leaf(lead), chain(rest));
}

const SIDE_PANELS: PanelId[] = ["mixer", "downloads", "browser"];

function framed(decks: Node, below: PanelId[], visible: (id: PanelId) => boolean, ratio: number, lead?: PanelId): Node {
  const others = below.filter(visible);
  const center: Node =
    others.length === 0
      ? decks
      : lead
        ? split("col", ratio, withLead(lead, 0.8, others), decks)
        : split("col", ratio, decks, chain(others));
  return visible("library") ? split("row", 0.2, leaf("library"), center) : center;
}

export function defaultTree(visible: (id: PanelId) => boolean): Node {
  const decks = split("row", 0.74, leaf("player"), leaf("metronome"));
  return framed(decks, SIDE_PANELS, visible, 0.5);
}

export const PRESETS = ["practice", "mixing"] as const;

export type PresetName = (typeof PRESETS)[number];

export function presetTree(name: PresetName, visible: (id: PanelId) => boolean): Node {
  if (name === "practice") return defaultTree(visible);
  const decks = split("row", 0.64, leaf("player"), leaf("metronome"));
  return framed(decks, SIDE_PANELS, visible, 0.64, "mixer");
}

function folded(node: Node, collapsed: ReadonlySet<PanelId>): boolean {
  return leaves(node).every((id) => collapsed.has(id));
}

export function geometry(node: Node, opts: GeoOptions = {}): Geometry {
  const rects: Partial<Record<PanelId, Rect>> = {};
  const gutters: GutterGeo[] = [];
  const folds: Partial<Record<PanelId, Fold>> = {};
  const collapsed = opts.collapsed;
  const stage = opts.stage;
  const measured = collapsed !== undefined && collapsed.size > 0 && stage !== undefined && stage.w > 0 && stage.h > 0;
  const walk = (n: Node, area: Rect, path: string) => {
    if (n.kind === "leaf") {
      rects[n.id] = area;
      return;
    }
    let ratio = n.ratio;
    let locked = false;
    if (measured && collapsed && stage) {
      const aFolded = folded(n.a, collapsed);
      const bFolded = folded(n.b, collapsed);
      if (aFolded !== bFolded) {
        const row = n.dir === "row";
        const size = row ? area.w * stage.w : area.h * stage.h;
        const px = row ? (opts.rail ?? 36) : (opts.bar ?? 38);
        const frac = size > 0 ? Math.min(0.5, px / size) : 0.5;
        ratio = aFolded ? frac : 1 - frac;
        locked = true;
        for (const id of leaves(aFolded ? n.a : n.b)) folds[id] = row ? "rail" : "bar";
      }
    }
    gutters.push({ path, dir: n.dir, ratio, area, locked });
    if (n.dir === "row") {
      const wa = area.w * ratio;
      walk(n.a, { x: area.x, y: area.y, w: wa, h: area.h }, path + "a");
      walk(n.b, { x: area.x + wa, y: area.y, w: area.w - wa, h: area.h }, path + "b");
    } else {
      const ha = area.h * ratio;
      walk(n.a, { x: area.x, y: area.y, w: area.w, h: ha }, path + "a");
      walk(n.b, { x: area.x, y: area.y + ha, w: area.w, h: area.h - ha }, path + "b");
    }
  };
  walk(node, { x: 0, y: 0, w: 1, h: 1 }, "");
  return { rects, gutters, folds };
}

export function clampRatio(ratio: number, sizePx: number, minPx: number): number {
  if (!(sizePx > 0)) return 0.5;
  const min = Math.min(0.5, Math.max(MIN_RATIO, minPx / sizePx));
  if (min >= 0.5) return 0.5;
  return Math.min(1 - min, Math.max(min, ratio));
}

export function withRatio(node: Node, path: string, ratio: number): Node {
  if (node.kind === "leaf") return node;
  if (path === "") return { ...node, ratio };
  if (path[0] === "a") return { ...node, a: withRatio(node.a, path.slice(1), ratio) };
  return { ...node, b: withRatio(node.b, path.slice(1), ratio) };
}

export function remove(node: Node, id: PanelId): Node | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const a = remove(node.a, id);
  const b = remove(node.b, id);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

function replaceLeaf(node: Node, id: PanelId, make: (l: Leaf) => Node): Node {
  if (node.kind === "leaf") return node.id === id ? make(node) : node;
  return { ...node, a: replaceLeaf(node.a, id, make), b: replaceLeaf(node.b, id, make) };
}

export function insertAt(node: Node, target: PanelId, id: PanelId, zone: Zone): Node {
  if (zone === "center") return node;
  const dir: Dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  return replaceLeaf(node, target, (l) => (first ? split(dir, 0.5, leaf(id), l) : split(dir, 0.5, l, leaf(id))));
}

export function swap(node: Node, a: PanelId, b: PanelId): Node {
  if (a === b) return node;
  if (node.kind === "leaf") {
    if (node.id === a) return leaf(b);
    if (node.id === b) return leaf(a);
    return node;
  }
  return { ...node, a: swap(node.a, a, b), b: swap(node.b, a, b) };
}

export function move(node: Node, id: PanelId, target: PanelId, zone: Zone): Node {
  if (id === target) return node;
  if (zone === "center") return swap(node, id, target);
  const rest = remove(node, id);
  if (rest === null || !has(rest, target)) return node;
  return insertAt(rest, target, id, zone);
}

function findDecks(node: Node): Node | null {
  if (node.kind === "leaf") return null;
  const ids = leaves(node);
  if (ids.length === 2 && ids.includes("player") && ids.includes("metronome")) return node;
  return findDecks(node.a) ?? findDecks(node.b);
}

function replaceNode(node: Node, target: Node, next: Node): Node {
  if (node === target) return next;
  if (node.kind === "leaf") return node;
  return { ...node, a: replaceNode(node.a, target, next), b: replaceNode(node.b, target, next) };
}

export function add(node: Node | null, id: PanelId): Node {
  if (node === null) return leaf(id);
  if (has(node, id)) return node;
  if (id === "library") return split("row", 0.2, leaf(id), node);
  const anchor = SIDE_PANELS.find((p) => has(node, p));
  if (anchor) return insertAt(node, anchor, id, "right");
  const decks = findDecks(node);
  if (decks) return replaceNode(node, decks, split("col", 0.52, decks, leaf(id)));
  if (has(node, "player")) return insertAt(node, "player", id, "bottom");
  return split("col", 0.58, node, leaf(id));
}

export function zoneAt(fx: number, fy: number, edge = 0.25): Zone {
  const d = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (d > edge) return "center";
  if (d === fx) return "left";
  if (d === 1 - fx) return "right";
  if (d === fy) return "top";
  return "bottom";
}

export function hintRect(area: Rect, zone: Zone): Rect {
  if (zone === "left") return { x: area.x, y: area.y, w: area.w / 2, h: area.h };
  if (zone === "right") return { x: area.x + area.w / 2, y: area.y, w: area.w / 2, h: area.h };
  if (zone === "top") return { x: area.x, y: area.y, w: area.w, h: area.h / 2 };
  if (zone === "bottom") return { x: area.x, y: area.y + area.h / 2, w: area.w, h: area.h / 2 };
  return area;
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (ALL_PANELS as string[]).includes(value);
}

export function parseTree(value: unknown, depth = 0): Node | null {
  if (depth > 12 || typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "leaf") return isPanelId(v.id) ? leaf(v.id) : null;
  if (v.kind !== "split") return null;
  if (v.dir !== "row" && v.dir !== "col") return null;
  if (typeof v.ratio !== "number" || !(v.ratio > 0 && v.ratio < 1)) return null;
  const a = parseTree(v.a, depth + 1);
  const b = parseTree(v.b, depth + 1);
  if (a === null || b === null) return null;
  return split(v.dir, v.ratio, a, b);
}

export function normalise(tree: Node | null, visible: (id: PanelId) => boolean): Node {
  let current: Node | null = tree;
  if (current !== null) {
    const ids = leaves(current);
    if (new Set(ids).size !== ids.length) {
      current = null;
    } else {
      for (const id of ids) {
        if (current !== null && !visible(id)) current = remove(current, id);
      }
    }
  }
  if (current === null) return defaultTree(visible);
  for (const id of ALL_PANELS) {
    if (visible(id) && !has(current, id)) current = add(current, id);
  }
  return current;
}
