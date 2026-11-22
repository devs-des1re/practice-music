export type Tone = "ok" | "warn" | "bad" | "idle";

export function stateTone(state: string | undefined): Tone {
  switch (state) {
    case "running":
      return "ok";
    case "starting":
    case "backoff":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "idle";
  }
}

export function stateLabel(state: string | undefined): string {
  switch (state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "backoff":
      return "Restarting";
    case "failed":
      return "Unavailable";
    case "stopped":
      return "Stopped";
    default:
      return "Connecting";
  }
}

export function formatRate(rate: number): string {
  const khz = rate / 1000;
  return `${parseFloat(khz.toFixed(2))} kHz`;
}

export function formatRates(rates: number[] | null | undefined): string {
  if (!rates || rates.length === 0) return "-";
  return rates.map((r) => (r / 1000).toString()).join(", ") + " kHz";
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function bufferLatencyMs(frames: number, rate: number): string {
  if (!frames || !rate) return "-";
  return `${((frames / rate) * 1000).toFixed(1)} ms`;
}
