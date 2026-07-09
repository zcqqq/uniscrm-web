import type { IntervalStats } from "../types";

export function computeStats(intervals: number[]): IntervalStats {
  if (intervals.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, median: 0, p25: 0, p75: 0, p90: 0 };
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count: n,
    min: Math.round(sorted[0]),
    max: Math.round(sorted[n - 1]),
    avg: Math.round(sum / n),
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo]);
  return Math.round(sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo));
}
