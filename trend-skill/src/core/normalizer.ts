import type { TrendItem } from "../types";

export function normalize(items: TrendItem[]): TrendItem[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], score: 100 }];

  const metricKey = Object.keys(items[0].rawMetrics)[0];
  const sorted = [...items].sort(
    (a, b) => (b.rawMetrics[metricKey] ?? 0) - (a.rawMetrics[metricKey] ?? 0)
  );

  const total = sorted.length;
  const scored = sorted.map((item, rank) => {
    let effectiveRank = rank;
    while (effectiveRank > 0 && sorted[effectiveRank - 1].rawMetrics[metricKey] === item.rawMetrics[metricKey]) {
      effectiveRank--;
    }
    return {
      ...item,
      score: Math.round(((total - 1 - effectiveRank) / (total - 1)) * 100),
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return scored;
}
