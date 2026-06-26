import type { TrendItem } from "./types";

export function normalizeScores(items: TrendItem[]): TrendItem[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], score: 100 }];

  const sorted = [...items].sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
  const n = sorted.length;

  const scoreToRank = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const score = sorted[i].score;
    if (!scoreToRank.has(score)) {
      scoreToRank.set(score, i);
    }
  }

  return sorted.map((item) => {
    const rank = scoreToRank.get(item.score)!;
    const percentile = Math.round(((n - 1 - rank) / (n - 1)) * 100);
    return { ...item, score: percentile };
  });
}
