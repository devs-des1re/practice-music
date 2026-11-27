export interface ContextItem {
  label: string;
  keys?: string;
  tone?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export interface ContextRequest {
  x: number;
  y: number;
  items: ContextItem[];
}

interface ContextShared {
  listeners: Set<(request: ContextRequest | null) => void>;
}

function contextState(): ContextShared {
  const holder = globalThis as unknown as { __pmContext?: ContextShared };
  if (!holder.__pmContext) holder.__pmContext = { listeners: new Set() };
  return holder.__pmContext;
}

export function subscribeContext(fn: (request: ContextRequest | null) => void): () => void {
  contextState().listeners.add(fn);
  return () => {
    contextState().listeners.delete(fn);
  };
}

export function tidyItems(items: ContextItem[]): ContextItem[] {
  const out: ContextItem[] = [];
  for (const item of items) {
    if (item.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(item);
  }
  if (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}

export const DIVIDER: ContextItem = { label: "", separator: true };

export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault: () => void },
  items: ContextItem[],
) {
  e.preventDefault();
  const request = { x: e.clientX, y: e.clientY, items: tidyItems(items) };
  for (const fn of contextState().listeners) fn(request);
}
