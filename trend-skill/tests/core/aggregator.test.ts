import { describe, it, expect, vi, beforeEach } from "vitest";
import { Aggregator } from "../../src/core/aggregator";
import type { TrendSource } from "../../src/sources/interface";
import type { TrendItem } from "../../src/types";

function createMockSource(platform: string, items: TrendItem[]): TrendSource {
  return {
    platform,
    fetchTrends: vi.fn(async () => items),
    isAvailable: vi.fn(async () => true),
  };
}

function createFailingSource(platform: string): TrendSource {
  return {
    platform,
    fetchTrends: vi.fn(async () => { throw new Error("API down"); }),
    isAvailable: vi.fn(async () => false),
  };
}

const twitterItems: TrendItem[] = [
  {
    id: "twitter:1",
    platform: "twitter",
    title: "Topic A",
    url: "https://x.com/1",
    score: 0,
    rawMetrics: { tweet_volume: 5000 },
    categories: [],
    timestamp: "2026-04-25T10:00:00Z",
  },
  {
    id: "twitter:2",
    platform: "twitter",
    title: "Topic B",
    url: "https://x.com/2",
    score: 0,
    rawMetrics: { tweet_volume: 10000 },
    categories: [],
    timestamp: "2026-04-25T10:00:00Z",
  },
];

describe("Aggregator", () => {
  it("fetches from all sources and returns normalized results", async () => {
    const source = createMockSource("twitter", twitterItems);
    const aggregator = new Aggregator([source]);
    const result = await aggregator.fetchAll();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].score).toBe(100);
    expect(result.items[1].score).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("continues when one source fails and reports the failure", async () => {
    const good = createMockSource("twitter", twitterItems);
    const bad = createFailingSource("weibo");
    const aggregator = new Aggregator([good, bad]);
    const result = await aggregator.fetchAll();

    expect(result.items).toHaveLength(2);
    expect(result.failures).toEqual(["weibo"]);
  });

  it("returns empty items when all sources fail", async () => {
    const bad = createFailingSource("twitter");
    const aggregator = new Aggregator([bad]);
    const result = await aggregator.fetchAll();

    expect(result.items).toEqual([]);
    expect(result.failures).toEqual(["twitter"]);
  });
});
