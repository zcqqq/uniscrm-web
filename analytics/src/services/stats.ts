import type { IntervalStats, BucketItem } from "../types";

const BUCKETS = [
  { label: "0-1m", rangeStart: 0, rangeEnd: 60 },
  { label: "1-5m", rangeStart: 60, rangeEnd: 300 },
  { label: "5-30m", rangeStart: 300, rangeEnd: 1800 },
  { label: "30m-1h", rangeStart: 1800, rangeEnd: 3600 },
  { label: "1-6h", rangeStart: 3600, rangeEnd: 21600 },
  { label: "6-24h", rangeStart: 21600, rangeEnd: 86400 },
  { label: "1-3d", rangeStart: 86400, rangeEnd: 259200 },
  { label: "3-7d", rangeStart: 259200, rangeEnd: 604800 },
  { label: "7-14d", rangeStart: 604800, rangeEnd: 1209600 },
  { label: "14-30d", rangeStart: 1209600, rangeEnd: 2592000 },
  { label: "30d+", rangeStart: 2592000, rangeEnd: Infinity },
];

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
