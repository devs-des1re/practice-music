export function applyScale(percent: number) {
  if (typeof document === "undefined") return;
  const clamped = Math.min(150, Math.max(80, percent || 100));
  document.documentElement.style.fontSize = `${clamped}%`;
}
