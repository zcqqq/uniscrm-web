import { describe, it, expect } from "vitest";
import { normalizeScores } from "../../src/core/normalizer";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, score: number): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform: "twitter",
    location: "global",
    language: "en",
    title,
    score,
    metrics: { tweet_volume: score },
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

describe("normalizeScores", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("assigns 100 to single item", () => {
    const items = [makeTrend("a", 500)];
    const result = normalizeScores(items);
    expect(result[0].score).toBe(100);
  });

  it("assigns percentile scores sorted descending", () => {
    const items = [makeTrend("low", 10), makeTrend("mid", 50), makeTrend("high", 100)];
    const result = normalizeScores(items);
    expect(result[0].title).toBe("high");
    expect(result[0].score).toBe(100);
    expect(result[1].title).toBe("mid");
    expect(result[1].score).toBeGreaterThan(0);
    expect(result[1].score).toBeLessThan(100);
    expect(result[2].title).toBe("low");
  });

  it("handles tied scores", () => {
    const items = [makeTrend("a", 50), makeTrend("b", 50), makeTrend("c", 100)];
    const result = normalizeScores(items);
    expect(result[0].score).toBe(100);
    expect(result[1].score).toBe(result[2].score);
  });
});
