export function clampNumber(text: string, min: number, max: number, decimals: number): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(Math.min(max, Math.max(min, value)) * factor) / factor;
}

export function parseLevel(text: string, min: number, max: number, decimals: number): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/\s*(db|%)$/, "")
    .trim();
  if (cleaned === "off" || cleaned === "-inf") return min;
  return clampNumber(cleaned, min, max, decimals);
}
