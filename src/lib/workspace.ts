export type PanelKey = "library" | "mixer" | "downloads" | "browser";

export type PanelSet = Record<PanelKey, boolean>;

export const defaultPanels: PanelSet = {
  library: true,
  mixer: true,
  downloads: false,
  browser: false,
};

const KEY = "pm.workspace.panels";

export function loadPanels(): PanelSet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultPanels };
    const parsed = JSON.parse(raw) as Partial<PanelSet>;
    return { ...defaultPanels, ...parsed, browser: false };
  } catch {
    return { ...defaultPanels };
  }
}

export function savePanels(panels: PanelSet) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...panels, browser: false }));
  } catch {
    return;
  }
}

export function lowerCount(panels: PanelSet): number {
  return (Object.keys(panels) as PanelKey[]).filter((k) => panels[k]).length;
}

export function panelShown(name: string): boolean {
  const el = document.querySelector('[data-tile="' + name + '"]');
  return !!el && el.getClientRects().length > 0;
}
