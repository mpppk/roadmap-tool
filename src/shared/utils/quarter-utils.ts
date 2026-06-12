export type QuarterYQ = { year: number; quarter: number };

type Quarter = { year: number; quarter: number };
type Month = { year: number; month: number };

export function quarterLabel(q: Quarter): string {
  return `${q.year} Q${q.quarter}`;
}

export function monthLabel(month: Month): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

export function quartersInRange(start: QuarterYQ, end: QuarterYQ): QuarterYQ[] {
  const result: QuarterYQ[] = [];
  let { year, quarter } = start;
  const endKey = end.year * 4 + end.quarter;
  while (year * 4 + quarter <= endKey) {
    result.push({ year, quarter });
    if (quarter === 4) {
      year++;
      quarter = 1;
    } else {
      quarter++;
    }
  }
  return result;
}

export function isQuarterInRange(
  q: QuarterYQ,
  start: QuarterYQ,
  end: QuarterYQ,
): boolean {
  const qKey = q.year * 4 + q.quarter;
  return (
    qKey >= start.year * 4 + start.quarter && qKey <= end.year * 4 + end.quarter
  );
}
