let order: number[] = [];

export function setQueue(ids: number[]) {
  order = ids.slice();
}

export function neighbour(current: number, delta: number): number {
  if (order.length === 0) return 0;
  const at = order.indexOf(current);
  if (at < 0) return delta > 0 ? order[0] : order[order.length - 1];
  const next = at + delta;
  if (next < 0 || next >= order.length) return 0;
  return order[next];
}
