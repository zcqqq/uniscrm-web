import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrendCache } from "../../src/storage/cache";
import type { TrendItem } from "../../src/types";

const sampleTrends: TrendItem[] = [
  {
    id: "twitter:1",
    platform: "twitter",
    title: "Test Trend",
    url: "https://x.com/trend/1",
    score: 100,
    rawMetrics: { tweet_volume: 5000 },
    categories: [],
    timestamp: "2026-04-25T10:00:00Z",
  },
];

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

describe("TrendCache", () => {
  let kv: KVNamespace;
  let cache: TrendCache;

  beforeEach(() => {
    kv = createMockKV();
    cache = new TrendCache(kv);
  });

  it("stores and retrieves latest trends", async () => {
    await cache.setLatest(sampleTrends);
    const result = await cache.getLatest();
    expect(result).toEqual(sampleTrends);
  });

  it("stores and retrieves platform-specific trends", async () => {
    await cache.setPlatformLatest("twitter", sampleTrends);
    const result = await cache.getPlatformLatest("twitter");
    expect(result).toEqual(sampleTrends);
  });

  it("returns null when cache is empty", async () => {
    const result = await cache.getLatest();
    expect(result).toBeNull();
  });
});
