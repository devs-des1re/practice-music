import { StartAudio } from "../../api/audio.go";
import { AUTO_RETRIES, describeError, isOffline, retryDelayMs } from "./errors";
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

const scope = globalThis as unknown as { __pmService?: Shared };

if (!scope.__pmService) {
  scope.__pmService = {
    state: { audio: "idle", message: "", attempts: 0, retryAt: 0, offline: false },
    current: null,
    timer: 0,
    lastAttempt: 0,
    listeners: new Set(),
  };
}

const shared = scope.__pmService;

function publish(patch: Partial<ServiceState>) {
  shared.state = { ...shared.state, ...patch };
  for (const fn of shared.listeners) fn(shared.state);
}

export function serviceState(): ServiceState {
  return shared.state;
}

export function subscribeService(fn: (s: ServiceState) => void): () => void {
  shared.listeners.add(fn);
  fn(shared.state);
  return () => {
    shared.listeners.delete(fn);
  };
}

export function onRefresh(fn: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, fn);
  return () => window.removeEventListener(REFRESH_EVENT, fn);
}

async function attempt(automatic: boolean): Promise<boolean> {
  shared.lastAttempt = Date.now();
  window.clearTimeout(shared.timer);
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
    const attempts = shared.state.attempts + 1;
    const message = describeError(e);
    logger.warn("audio did not start: " + message);
    if (automatic && attempts >= AUTO_RETRIES) {
      publish({ audio: "paused", message, attempts, retryAt: 0 });
      return false;
    }
    const delay = retryDelayMs(attempts - 1);
    publish({ audio: "failed", message, attempts, retryAt: Date.now() + delay });
    shared.timer = window.setTimeout(() => {
      void begin(true);
    }, delay);
    return false;
  }
}

function begin(automatic: boolean): Promise<boolean> {
  if (shared.current) return shared.current;
  const run = attempt(automatic).finally(() => {
    shared.current = null;
  });
  shared.current = run;
  return run;
}

export function requestAudio() {
  if (shared.state.audio !== "idle" || shared.current !== null) return;
  if (Date.now() - shared.lastAttempt < MIN_GAP_MS) return;
  void begin(true);
}

export function noteAudioRunning(running: boolean) {
  if (running && shared.state.audio !== "ready") {
    window.clearTimeout(shared.timer);
    publish({ audio: "ready", message: "", attempts: 0, retryAt: 0 });
  } else if (!running && shared.state.audio === "ready") {
    publish({ audio: "idle" });
  }
}

export function retryAudio(): Promise<boolean> {
  if (shared.current) return shared.current;
  publish({ attempts: 0 });
  return begin(false);
}

export async function startAudioForUser(): Promise<void> {
  const ok = await retryAudio();
  if (!ok) throw new ReportedError(shared.state.offline ? "The PracticeMusic host is not reachable." : shared.state.message);
}

export function reportOffline() {
  if (!shared.state.offline) publish({ offline: true });
}

export function reportOnline() {
  if (!shared.state.offline) return;
  publish({ offline: false, audio: shared.state.audio === "starting" ? "idle" : shared.state.audio });
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
  logger.error(context, e);
}
