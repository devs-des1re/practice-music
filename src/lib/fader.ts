const PAGE_DB = 6;

export function snapFader(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  return Math.round(Math.min(max, Math.max(min, snapped)) * 1000) / 1000;
}

export function faderValueAt(fromTop: number, travel: number, min: number, max: number, step: number): number {
  if (travel <= 0) return min;
  const fraction = 1 - Math.min(1, Math.max(0, fromTop / travel));
  return snapFader(min + fraction * (max - min), min, max, step);
}

export function faderKeyValue(key: string, value: number, min: number, max: number, step: number): number | null {
  if (key === "Home") return max;
  if (key === "End") return min;
  const moves: Record<string, number> = {
    ArrowUp: step,
    ArrowRight: step,
    ArrowDown: -step,
    ArrowLeft: -step,
    PageUp: PAGE_DB,
    PageDown: -PAGE_DB,
  };
  if (!(key in moves)) return null;
  return snapFader(value + moves[key], min, max, step);
}
