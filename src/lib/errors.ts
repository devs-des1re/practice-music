const OFFLINE = /failed to fetch|networkerror|load failed|network request failed|err_connection|err_insufficient|go host is not reachable|connection refused|actively refused|dial unix|socket hang up/i;
const PREFIX = /^[a-z]+_error:\s*/i;
const RETRY_STEPS_MS = [3000, 6000, 12000, 24000, 30000];

export const AUTO_RETRIES = 5;

export function isOffline(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return OFFLINE.test(message);
}

export function describeError(e: unknown): string {
  if (isOffline(e)) return "The PracticeMusic host is not reachable.";
  const raw = e instanceof Error ? e.message : String(e);
  const stripped = raw.replace(PREFIX, "").trim();
  const text = stripped.length > 0 ? stripped : raw.trim();
  if (text.length === 0) return "Something went wrong.";
  const first = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(first) ? first : first + ".";
}

export function retryDelayMs(attempt: number): number {
  const at = Math.max(0, Math.min(RETRY_STEPS_MS.length - 1, Math.floor(attempt)));
  return RETRY_STEPS_MS[at];
}

export function countdownText(retryAt: number, now: number): string {
  if (retryAt <= 0) return "";
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return seconds <= 1 ? "Trying again now." : "Trying again in " + seconds + " seconds.";
}
