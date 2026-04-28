import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTrendsRouter } from "../../src/api/trends";
import type { TrendItem, Env } from "../../src/types";

function makeTrend(title: string, location = "global", language = "en"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:test`,
    platform: "twitter",
    location,
    language,
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeApp = (kvData: TrendItem[] | null = null) => {
  const app = new Hono<{ Bindings: Env }>();

  const mockKv = {
    get: vi.fn().mockResolvedValue(kvData ? JSON.stringify(kvData) : null),
  };

  app.use("*", async (c, next) => {
    (c.env as any) = { TREND_KV: mockKv };
    c.set("tier" as never, "anonymous");
    await next();
  });

  app.route("/api", createTrendsRouter());
  return app;
};

describe("GET /api/trends", () => {
  it("returns latest trends from KV", async () => {
    const trends = [makeTrend("AI"), makeTrend("Climate")];
    const app = makeApp(trends);
    const res = await app.request("/api/trends");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
  });

  it("filters by location", async () => {
    const trends = [makeTrend("AI", "global"), makeTrend("Topic", "china", "zh")];
    const app = makeApp(trends);
    const res = await app.request("/api/trends?location=china");
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].location).toBe("china");
  });

  it("returns empty array when KV is empty", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/trends");
    const data = await res.json();
    expect(data.items).toEqual([]);
  });
});
