export type CapacityAggMode = "total" | "average";

export const r2 = (v: number) => Math.round(v * 100) / 100;

export function fmt(v: number): string {
  if (v === 0) return "0";
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, "");
}

export function fmt2(v: number): string {
  return v.toFixed(2);
}

export function heatBg(
  value: number,
  maxVal: number,
): { bg: string; fg: string } {
  if (value <= 0) return { bg: "transparent", fg: "var(--cv-text-3)" };
  const t = Math.min(value / maxVal, 1);
  const L = Math.round(96 - t * 78);
  const bg = `oklch(${L}% 0.01 250)`;
  const fg = L < 52 ? "#fff" : "var(--cv-text)";
  return { bg, fg };
}

export function readStoredCapacityAggMode(
  key: string,
  defaultValue: CapacityAggMode,
): CapacityAggMode {
  try {
    const v = localStorage.getItem(key);
    if (v === "total" || v === "average") return v;
  } catch {}
  return defaultValue;
}
