import { describe, it, expect, vi } from "vitest";
import { createContextRouter } from "../../src/api/context";
import { Hono } from "hono";
import type { Env, TrendItem } from "../../src/types";

const sampleTrend: TrendItem = {
  id: "twitter:1",
  platform: "twitter",
  title: "AI Trend",
  url: "https://x.com/1",
  score: 95,
  rawMetrics: { tweet_volume: 5000 },
  categories: ["tech"],
  timestamp: "2026-04-25T10:00:00Z",
};

function createTestApp(kvData: Record<string, string>) {
  const mockKV = {
    get: vi.fn(async (key: string) => kvData[key] ?? null),
  } as unknown as KVNamespace;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", createContextRouter());

  return {
    request: (path: string) =>
      app.request(path, {}, { TREND_KV: mockKV } as unknown as Env),
  };
}

describe("GET /api/write-context", () => {
  it("returns WriteContext with rendered template", async () => {
    const { request } = createTestApp({
      "trends:latest": JSON.stringify([sampleTrend]),
    });
    const res = await request("/api/write-context?format=tweet&trendIds=twitter:1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("tweet");
    expect(body.template).toContain("AI Trend");
    expect(body.trends).toHaveLength(1);
  });

  it("returns 400 when format is missing", async () => {
    const { request } = createTestApp({});
    const res = await request("/api/write-context");
    expect(res.status).toBe(400);
  });

  it("returns 400 when format is invalid", async () => {
    const { request } = createTestApp({});
    const res = await request("/api/write-context?format=invalid");
    expect(res.status).toBe(400);
  });
});
