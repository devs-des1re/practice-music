import { GetSettings } from "../../api/host.go";
import { FALLBACK_PREFERENCES, type PreferenceValues } from "./prefs-model";
import { applyScale } from "./appearance";
import { logger } from "./logger";

interface PreferenceStore {
  value: PreferenceValues;
  loaded: boolean;
  loading: boolean;
  listeners: Set<(value: PreferenceValues) => void>;
}

function preferenceStore(): PreferenceStore {
  const holder = globalThis as unknown as { __pmPrefs?: PreferenceStore };
  if (!holder.__pmPrefs)
    holder.__pmPrefs = { value: { ...FALLBACK_PREFERENCES }, loaded: false, loading: false, listeners: new Set() };
  return holder.__pmPrefs;
}

export function currentPrefs(): PreferenceValues {
  return preferenceStore().value;
}

export function applyPrefs(value: PreferenceValues) {
  const store = preferenceStore();
  store.value = { ...value };
  store.loaded = true;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.glass = value.glass;
    document.documentElement.dataset.corners = value.corners;
  }
  for (const fn of store.listeners) fn(store.value);
}

export function ensurePrefs() {
  const store = preferenceStore();
  if (store.loaded || store.loading) return;
  store.loading = true;
  GetSettings()
    .then((doc) => {
      applyScale(doc.settings.appearance.uiScale);
      applyPrefs(doc.settings.preferences);
    })
    .catch((e) => logger.warn("preferences were not loaded", e))
    .finally(() => {
      preferenceStore().loading = false;
    });
}

export function subscribePrefs(fn: (value: PreferenceValues) => void): () => void {
  preferenceStore().listeners.add(fn);
  fn(preferenceStore().value);
  ensurePrefs();
  return () => {
    preferenceStore().listeners.delete(fn);
  };
}
