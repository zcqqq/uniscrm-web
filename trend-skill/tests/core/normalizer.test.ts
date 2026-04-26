import { describe, it, expect } from "vitest";
import { normalize } from "../../src/core/normalizer";
import type { TrendItem } from "../../src/types";

function makeTrend(id: string, platform: "twitter", rawScore: number, timestamp: string): TrendItem {
  return {
    id,
    platform,
    title: `Trend ${id}`,
    url: `https://x.com/trend/${id}`,
    score: 0,
    rawMetrics: { tweet_volume: rawScore },
    categories: [],
    timestamp,
  };
}

describe("normalize", () => {
  it("assigns score 100 to the highest-ranked item", () => {
    const items = [
      makeTrend("twitter:1", "twitter", 500, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:2", "twitter", 1000, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:3", "twitter", 200, "2026-04-25T10:00:00Z"),
    ];
    const result = normalize(items);
    const top = result.find((t) => t.id === "twitter:2")!;
    expect(top.score).toBe(100);
  });

  it("assigns score 0 to the lowest-ranked item", () => {
    const items = [
      makeTrend("twitter:1", "twitter", 500, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:2", "twitter", 1000, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:3", "twitter", 200, "2026-04-25T10:00:00Z"),
    ];
    const result = normalize(items);
    const bottom = result.find((t) => t.id === "twitter:3")!;
    expect(bottom.score).toBe(0);
  });

  it("assigns score 50 to the middle item in a 3-item list", () => {
    const items = [
      makeTrend("twitter:1", "twitter", 500, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:2", "twitter", 1000, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:3", "twitter", 200, "2026-04-25T10:00:00Z"),
    ];
    const result = normalize(items);
    const mid = result.find((t) => t.id === "twitter:1")!;
    expect(mid.score).toBe(50);
  });

  it("returns score 100 for a single item", () => {
    const items = [makeTrend("twitter:1", "twitter", 42, "2026-04-25T10:00:00Z")];
    const result = normalize(items);
    expect(result[0].score).toBe(100);
  });

  it("returns items sorted by score descending, then by timestamp descending", () => {
    const items = [
      makeTrend("twitter:1", "twitter", 500, "2026-04-25T09:00:00Z"),
      makeTrend("twitter:2", "twitter", 500, "2026-04-25T10:00:00Z"),
      makeTrend("twitter:3", "twitter", 1000, "2026-04-25T08:00:00Z"),
    ];
    const result = normalize(items);
    expect(result.map((t) => t.id)).toEqual(["twitter:3", "twitter:2", "twitter:1"]);
  });
});
