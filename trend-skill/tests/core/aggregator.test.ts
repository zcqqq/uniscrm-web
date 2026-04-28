import { describe, it, expect } from "vitest";
import { Aggregator } from "../../src/core/aggregator";
import type { TrendSource } from "../../src/sources/interface";
import type { TrendItem, Platform } from "../../src/types";

function makeSource(platform: Platform, items: TrendItem[], available = true): TrendSource {
  return {
    platform,
    fetchTrends: () => Promise.resolve(items),
    isAvailable: () => Promise.resolve(available),
  };
}

function makeTrend(platform: Platform, title: string, score: number): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform,
    location: "global",
    language: "en",
    title,
    score,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

describe("Aggregator", () => {
  it("fetches from all available sources and normalizes", async () => {
    const source = makeSource("twitter", [
      makeTrend("twitter", "Topic A", 100),
      makeTrend("twitter", "Topic B", 50),
    ]);
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].score).toBe(100);
    expect(result.items[1].score).toBe(0);
    expect(result.failedPlatforms).toEqual([]);
  });

  it("skips unavailable sources and records them as failed", async () => {
    const source = makeSource("twitter", [], false);
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toEqual([]);
    expect(result.failedPlatforms).toEqual(["twitter"]);
  });

  it("catches source errors and records platform as failed", async () => {
    const source: TrendSource = {
      platform: "twitter",
      fetchTrends: () => Promise.reject(new Error("API down")),
      isAvailable: () => Promise.resolve(true),
    };
    const agg = new Aggregator([source]);
    const result = await agg.fetchAll();

    expect(result.items).toEqual([]);
    expect(result.failedPlatforms).toEqual(["twitter"]);
  });
});
