import { describe, it, expect, vi } from "vitest";
import { handleTrendingNow, handleSearchTrends, handleGetDailyDigest } from "../../src/mcp/tools";
import type { TrendItem, Env } from "../../src/types";

function makeTrend(title: string, location = "global"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:test`,
    platform: "twitter",
    location,
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeEnv = (kvData: TrendItem[] | null = null) =>
  ({
    TREND_KV: {
      get: vi.fn().mockResolvedValue(kvData ? JSON.stringify(kvData) : null),
    },
    TREND_VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
    },
    AI: {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }),
    },
  }) as unknown as Env;

describe("handleTrendingNow", () => {
  it("returns top trends from KV", async () => {
    const trends = [makeTrend("AI"), makeTrend("Climate")];
    const env = makeEnv(trends);
    const result = await handleTrendingNow(env, { limit: 10 });
    expect(result.items).toHaveLength(2);
  });

  it("filters by location", async () => {
    const trends = [makeTrend("AI", "global"), makeTrend("Topic", "china")];
    const env = makeEnv(trends);
    const result = await handleTrendingNow(env, { location: "china", limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].location).toBe("china");
  });
});

describe("handleSearchTrends", () => {
  it("calls vectorize search with filters", async () => {
    const item = makeTrend("AI");
    const env = makeEnv();
    (env.TREND_VECTORIZE as any).query.mockResolvedValue({
      matches: [{ id: item.id, score: 0.95, metadata: { item: JSON.stringify(item) } }],
    });

    const result = await handleSearchTrends(env, { query: "artificial intelligence", limit: 10 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].similarity).toBe(0.95);
  });
});

describe("handleGetDailyDigest", () => {
  it("returns digest structure", async () => {
    const env = makeEnv([makeTrend("AI")]);
    const result = await handleGetDailyDigest(env);
    expect(result).toHaveProperty("persistent_topics");
    expect(result).toHaveProperty("cross_platform_topics");
  });
});
