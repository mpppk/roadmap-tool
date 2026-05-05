export function parseCapacityTSV(text: string): number[][] | null {
  const rows: number[][] = [];

  const withoutTrailingNewlines = text.replace(/(?:\r?\n)+$/, "");
  for (const line of withoutTrailingNewlines.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const row: number[] = [];
    for (const cell of line.split("\t")) {
      const value = parseNonNegativeNumber(cell);
      if (value === null) return null;
      row.push(value);
    }
    rows.push(row);
  }

  return rows.length > 0 ? rows : null;
}

function parseNonNegativeNumber(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
