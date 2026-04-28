import { describe, it, expect, vi } from "vitest";
import { buildDailyDigest } from "../../src/push/digest";
import type { TrendItem, TrendSearchResult } from "../../src/types";
import type { TrendVectorStore } from "../../src/storage/vectorize";

function makeTrend(title: string, date: string, location = "global"): TrendItem {
  return {
    id: `${date}:tw:gl:abc12345`,
    platform: "twitter",
    location,
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: [],
    timestamp: `${date}T00:00:00Z`,
  };
}

const makeStoreMock = (searchResults: TrendSearchResult[]): TrendVectorStore => ({
  search: vi.fn().mockResolvedValue(searchResults),
  upsertTrends: vi.fn(),
  cleanupOld: vi.fn(),
  buildEmbeddingText: vi.fn(),
}) as unknown as TrendVectorStore;

describe("buildDailyDigest", () => {
  it("returns persistent topics that appear both days", async () => {
    const yesterday = [makeTrend("AI Revolution", "2026-04-27")];
    const todayMatch: TrendSearchResult = {
      item: makeTrend("AI Revolution", "2026-04-28"),
      similarity: 0.92,
    };

    const store = makeStoreMock([todayMatch]);
    const digest = await buildDailyDigest(store, yesterday, "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(1);
    expect(digest.persistent_topics[0].title).toBe("AI Revolution");
    expect(digest.persistent_topics[0].days_trending).toBe(2);
  });

  it("excludes topics below similarity threshold", async () => {
    const yesterday = [makeTrend("Old Topic", "2026-04-27")];
    const weakMatch: TrendSearchResult = {
      item: makeTrend("Different Topic", "2026-04-28"),
      similarity: 0.60,
    };

    const store = makeStoreMock([weakMatch]);
    const digest = await buildDailyDigest(store, yesterday, "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(0);
  });

  it("returns empty digest when no yesterday trends", async () => {
    const store = makeStoreMock([]);
    const digest = await buildDailyDigest(store, [], "2026-04-28");

    expect(digest.persistent_topics).toHaveLength(0);
    expect(digest.cross_platform_topics).toHaveLength(0);
  });
});
