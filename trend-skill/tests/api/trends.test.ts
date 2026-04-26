import { describe, it, expect, vi } from "vitest";
import { createTrendsRouter } from "../../src/api/trends";
import { Hono } from "hono";
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

function createTestApp(kvData: Record<string, string>, searchResults: TrendItem[] = []) {
  const mockKV = {
    get: vi.fn(async (key: string) => kvData[key] ?? null),
  } as unknown as KVNamespace;

  const mockVectorize = {
    query: vi.fn(async () => ({
      matches: searchResults.map((item) => ({
        id: item.id,
        score: 0.9,
        metadata: { item: JSON.stringify(item) },
      })),
    })),
  } as unknown as VectorizeIndex;

  const mockAI = {
    run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })),
  } as unknown as Ai;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", createTrendsRouter());

  return {
    app,
    request: (path: string) =>
      app.request(path, {}, {
        TREND_KV: mockKV,
        TREND_VECTORIZE: mockVectorize,
        AI: mockAI,
      } as unknown as Env),
  };
}

describe("GET /api/trends", () => {
  it("returns cached trends when no query param", async () => {
    const { request } = createTestApp({
      "trends:latest": JSON.stringify(sampleTrends),
    });
    const res = await request("/api/trends");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trends).toHaveLength(1);
    expect(body.trends[0].title).toBe("Test Trend");
  });

  it("returns 503 when cache is empty", async () => {
    const { request } = createTestApp({});
    const res = await request("/api/trends");
    expect(res.status).toBe(503);
  });

  it("returns platform-specific trends when platform param given", async () => {
    const { request } = createTestApp({
      "trends:twitter:latest": JSON.stringify(sampleTrends),
    });
    const res = await request("/api/trends?platform=twitter");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trends).toHaveLength(1);
  });

  it("returns semantic search results when query param given", async () => {
    const recentTrend: TrendItem = {
      ...sampleTrends[0],
      timestamp: new Date().toISOString(),
    };
    const { request } = createTestApp({}, [recentTrend]);
    const res = await request("/api/trends?query=test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].similarity).toBeDefined();
  });
});
