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
}

export interface Geometry {
  rects: Partial<Record<PanelId, Rect>>;
  gutters: GutterGeo[];
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

export function defaultTree(visible: (id: PanelId) => boolean): Node {
  const top = split("row", 0.72, leaf("player"), leaf("metronome"));
  const lower = LOWER_PANELS.filter(visible);
  if (lower.length === 0) return top;
  return split("col", 0.58, top, chain(lower));
}

export function geometry(node: Node): Geometry {
  const rects: Partial<Record<PanelId, Rect>> = {};
  const gutters: GutterGeo[] = [];
  const walk = (n: Node, area: Rect, path: string) => {
    if (n.kind === "leaf") {
      rects[n.id] = area;
      return;
    }
    gutters.push({ path, dir: n.dir, ratio: n.ratio, area });
    if (n.dir === "row") {
      const wa = area.w * n.ratio;
      walk(n.a, { x: area.x, y: area.y, w: wa, h: area.h }, path + "a");
      walk(n.b, { x: area.x + wa, y: area.y, w: area.w - wa, h: area.h }, path + "b");
    } else {
      const ha = area.h * n.ratio;
      walk(n.a, { x: area.x, y: area.y, w: area.w, h: ha }, path + "a");
      walk(n.b, { x: area.x, y: area.y + ha, w: area.w, h: area.h - ha }, path + "b");
    }
  };
  walk(node, { x: 0, y: 0, w: 1, h: 1 }, "");
  return { rects, gutters };
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

export function add(node: Node | null, id: PanelId): Node {
  if (node === null) return leaf(id);
  if (has(node, id)) return node;
  const anchor = LOWER_PANELS.find((p) => has(node, p));
  if (anchor) return insertAt(node, anchor, id, "right");
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
