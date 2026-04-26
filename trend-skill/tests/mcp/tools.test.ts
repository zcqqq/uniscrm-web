import { describe, it, expect, vi } from "vitest";
import { handleListPlatforms, handleListFormats, handleQueryTrends } from "../../src/mcp/tools";
import type { Env, TrendItem } from "../../src/types";

const sampleTrends: TrendItem[] = [
  {
    id: "twitter:1",
    platform: "twitter",
    title: "Test Trend",
    url: "https://x.com/1",
    score: 100,
    rawMetrics: { tweet_volume: 5000 },
    categories: ["tech"],
    timestamp: "2026-04-25T10:00:00Z",
  },
];

function createMockEnv(kvData: Record<string, string> = {}): Env {
  return {
    TREND_KV: {
      get: vi.fn(async (key: string) => kvData[key] ?? null),
    } as unknown as KVNamespace,
    TREND_VECTORIZE: {} as VectorizeIndex,
    AI: {} as Ai,
    TREND_DB: {} as D1Database,
    TWITTER_BEARER_TOKEN: "",
    ADMIN_SECRET: "",
  };
}

describe("MCP tool handlers", () => {
  it("list_platforms returns twitter as available", async () => {
    const result = await handleListPlatforms();
    expect(result.platforms).toContainEqual(
      expect.objectContaining({ name: "twitter", status: "active" })
    );
  });

  it("list_formats returns 5 formats", async () => {
    const result = await handleListFormats();
    expect(result.formats).toHaveLength(5);
  });

  it("query_trends returns cached trends", async () => {
    const env = createMockEnv({ "trends:latest": JSON.stringify(sampleTrends) });
    const result = await handleQueryTrends(env, {});
    expect(result.trends).toHaveLength(1);
    expect(result.trends[0].title).toBe("Test Trend");
  });

  it("query_trends filters by platform", async () => {
    const env = createMockEnv({
      "trends:twitter:latest": JSON.stringify(sampleTrends),
    });
    const result = await handleQueryTrends(env, { platform: "twitter" });
    expect(result.trends).toHaveLength(1);
  });
});
