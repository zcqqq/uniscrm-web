import { BUCKETS } from "../constants";
import type { IntervalStats, BucketItem } from "../types";

export function computeStats(intervals: number[]): IntervalStats {
  if (intervals.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, median: 0, p25: 0, p75: 0, p90: 0 };
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
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

export function computeDistribution(intervals: number[]): BucketItem[] {
  const total = intervals.length;
  if (total === 0) {
    return BUCKETS.map((b) => ({ ...b, count: 0, percentage: 0 }));
  }

  const counts = new Array(BUCKETS.length).fill(0);
  for (const val of intervals) {
    for (let i = 0; i < BUCKETS.length; i++) {
      if (val >= BUCKETS[i].rangeStart && val < BUCKETS[i].rangeEnd) {
        counts[i]++;
        break;
      }
    }
  }

  return BUCKETS.map((b, i) => ({
    label: b.label,
    rangeStart: b.rangeStart,
    rangeEnd: b.rangeEnd,
    count: counts[i],
    percentage: Math.round((counts[i] / total) * 1000) / 10,
  }));
}
