import { StartAudio } from "../../api/audio.go";
import { AUTO_RETRIES, describeError, isOffline, isRefusal, retryDelayMs } from "./errors";
import { logger } from "./logger";

export type AudioPhase = "idle" | "starting" | "ready" | "failed" | "paused";

export interface ServiceState {
  audio: AudioPhase;
  message: string;
  attempts: number;
  retryAt: number;
  offline: boolean;
}

export class ReportedError extends Error {}

const MIN_GAP_MS = 1500;
const REFRESH_EVENT = "pm:refresh";

interface Shared {
  state: ServiceState;
  current: Promise<boolean> | null;
  timer: number;
  lastAttempt: number;
  listeners: Set<(s: ServiceState) => void>;
}

function serviceShared(): Shared {
  const holder = globalThis as unknown as { __pmService?: Shared };
  if (!holder.__pmService) {
    holder.__pmService = {
      state: { audio: "idle", message: "", attempts: 0, retryAt: 0, offline: false },
      current: null,
      timer: 0,
      lastAttempt: 0,
      listeners: new Set(),
    };
  }
  return holder.__pmService;
}

function publish(patch: Partial<ServiceState>) {
  const store = serviceShared();
  store.state = { ...store.state, ...patch };
  for (const fn of store.listeners) fn(store.state);
}

export function serviceState(): ServiceState {
  return serviceShared().state;
}

export function subscribeService(fn: (s: ServiceState) => void): () => void {
  serviceShared().listeners.add(fn);
  fn(serviceShared().state);
  return () => {
    serviceShared().listeners.delete(fn);
  };
}

export function onRefresh(fn: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, fn);
  return () => window.removeEventListener(REFRESH_EVENT, fn);
}

async function attempt(automatic: boolean): Promise<boolean> {
  serviceShared().lastAttempt = Date.now();
  window.clearTimeout(serviceShared().timer);
  publish({ audio: "starting", retryAt: 0 });
  try {
    await StartAudio();
    publish({ audio: "ready", message: "", attempts: 0, retryAt: 0 });
    return true;
  } catch (e) {
    if (isOffline(e)) {
      publish({ audio: "idle", retryAt: 0, offline: true });
      return false;
    }
    const attempts = serviceShared().state.attempts + 1;
    const message = describeError(e);
    logger.warn("audio did not start: " + message);
    if (automatic && attempts >= AUTO_RETRIES) {
      publish({ audio: "paused", message, attempts, retryAt: 0 });
      return false;
    }
    const delay = retryDelayMs(attempts - 1);
    publish({ audio: "failed", message, attempts, retryAt: Date.now() + delay });
    serviceShared().timer = window.setTimeout(() => {
      void begin(true);
    }, delay);
    return false;
  }
}

function begin(automatic: boolean): Promise<boolean> {
  const pending = serviceShared().current;
  if (pending) return pending;
  const run = attempt(automatic).finally(() => {
    serviceShared().current = null;
  });
  serviceShared().current = run;
  return run;
}

export function requestAudio() {
  if (serviceShared().state.audio !== "idle" || serviceShared().current !== null) return;
  if (Date.now() - serviceShared().lastAttempt < MIN_GAP_MS) return;
  void begin(true);
}

export function noteAudioRunning(running: boolean) {
  if (running && serviceShared().state.audio !== "ready") {
    window.clearTimeout(serviceShared().timer);
    publish({ audio: "ready", message: "", attempts: 0, retryAt: 0 });
  } else if (!running && serviceShared().state.audio === "ready") {
    publish({ audio: "idle" });
  }
}

export function retryAudio(): Promise<boolean> {
  const pending = serviceShared().current;
  if (pending) return pending;
  publish({ attempts: 0 });
  return begin(false);
}

export async function startAudioForUser(): Promise<void> {
  const ok = await retryAudio();
  if (!ok)
    throw new ReportedError(
      serviceShared().state.offline ? "The PracticeMusic host is not reachable." : serviceShared().state.message,
    );
}

export function reportOffline() {
  if (!serviceShared().state.offline) publish({ offline: true });
}

export function reportOnline() {
  if (!serviceShared().state.offline) return;
  publish({ offline: false, audio: serviceShared().state.audio === "starting" ? "idle" : serviceShared().state.audio });
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

export function handleError(e: unknown, show: (message: string) => void) {
  if (e instanceof ReportedError) return;
  if (isOffline(e)) {
    reportOffline();
    return;
  }
  show(describeError(e));
}

export function logFailure(context: string, e: unknown) {
  if (e instanceof ReportedError) return;
  if (isOffline(e)) {
    reportOffline();
    logger.warn(context + ": the host is not reachable");
    return;
  }
  if (isRefusal(e)) {
    logger.warn(context + ": " + describeError(e));
    return;
  }
  logger.error(context, e);
}
