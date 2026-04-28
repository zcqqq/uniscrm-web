import { describe, it, expect, beforeEach } from "vitest";
import { TrendCache } from "../../src/storage/cache";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, platform = "twitter", location = "global"): TrendItem {
  return {
    id: `2026-04-28:tw:gl:${title}`,
    platform: platform as TrendItem["platform"],
    location,
    language: "en",
    title,
    score: 50,
    metrics: {},
    categories: [],
    timestamp: "2026-04-28T00:00:00Z",
  };
}

const makeKvMock = () => {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
    _store: store,
  } as unknown as KVNamespace;
};

describe("TrendCache", () => {
  let kv: KVNamespace;
  let cache: TrendCache;

  beforeEach(() => {
    kv = makeKvMock();
    cache = new TrendCache(kv);
  });

  it("setLatest and getLatest round-trip", async () => {
    const items = [makeTrend("A"), makeTrend("B")];
    await cache.setLatest(items);
    const result = await cache.getLatest();
    expect(result).toEqual(items);
  });

  it("getLatest returns null when empty", async () => {
    expect(await cache.getLatest()).toBeNull();
  });

  it("setPlatformLatest and getPlatformLatest round-trip", async () => {
    const items = [makeTrend("X", "twitter", "china")];
    await cache.setPlatformLatest("twitter", "china", items);
    const result = await cache.getPlatformLatest("twitter", "china");
    expect(result).toEqual(items);
  });

  it("overwrites on second set (no TTL)", async () => {
    await cache.setLatest([makeTrend("old")]);
    await cache.setLatest([makeTrend("new")]);
    const result = await cache.getLatest();
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe("new");
  });
});
