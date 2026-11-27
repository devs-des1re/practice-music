export function clampNumber(text: string, min: number, max: number, decimals: number): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(Math.min(max, Math.max(min, value)) * factor) / factor;
}
