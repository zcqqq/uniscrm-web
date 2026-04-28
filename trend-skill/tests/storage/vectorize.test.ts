import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrendVectorStore } from "../../src/storage/vectorize";
import type { TrendItem } from "../../src/types";

function makeTrend(title: string, date = "2026-04-28"): TrendItem {
  return {
    id: `${date}:tw:gl:abc12345`,
    platform: "twitter",
    location: "global",
    language: "en",
    title,
    score: 80,
    metrics: {},
    categories: ["Technology"],
    timestamp: `${date}T00:00:00Z`,
  };
}

describe("TrendVectorStore", () => {
  let vectorize: any;
  let ai: any;
  let store: TrendVectorStore;

  beforeEach(() => {
    vectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ matches: [] }),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };
    store = new TrendVectorStore(vectorize, ai);
  });

  describe("buildEmbeddingText", () => {
    it("concatenates title, description, and categories", () => {
      const item = { ...makeTrend("AI"), description: "Artificial intelligence", categories: ["Tech", "Science"] };
      expect(store.buildEmbeddingText(item)).toBe("AI | Artificial intelligence | Tech, Science");
    });

    it("omits missing optional fields", () => {
      const item = makeTrend("AI");
      item.categories = [];
      expect(store.buildEmbeddingText(item)).toBe("AI");
    });
  });

  describe("upsertTrends", () => {
    it("generates embeddings and upserts with metadata", async () => {
      const items = [makeTrend("AI Topic")];
      ai.run.mockResolvedValue({ data: [[0.1, 0.2, 0.3]] });

      await store.upsertTrends(items);

      expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: ["AI Topic | Technology"] });
      expect(vectorize.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          id: items[0].id,
          values: [0.1, 0.2, 0.3],
          metadata: expect.objectContaining({
            type: "trend",
            platform: "twitter",
            location: "global",
            language: "en",
            date: "2026-04-28",
            title: "AI Topic",
          }),
        }),
      ]);
    });

    it("skips empty array", async () => {
      await store.upsertTrends([]);
      expect(ai.run).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("embeds query and returns matched items with similarity", async () => {
      const item = makeTrend("Result");
      ai.run.mockResolvedValue({ data: [[0.5, 0.5, 0.5]] });
      vectorize.query.mockResolvedValue({
        matches: [{ id: item.id, score: 0.92, metadata: { item: JSON.stringify(item) } }],
      });

      const results = await store.search("test query");

      expect(results).toHaveLength(1);
      expect(results[0].item.title).toBe("Result");
      expect(results[0].similarity).toBe(0.92);
    });

    it("passes filters to vectorize query", async () => {
      ai.run.mockResolvedValue({ data: [[0.5, 0.5, 0.5]] });
      vectorize.query.mockResolvedValue({ matches: [] });

      await store.search("test", 10, { platform: "twitter", location: "china" });

      expect(vectorize.query).toHaveBeenCalledWith(
        [0.5, 0.5, 0.5],
        expect.objectContaining({
          filter: { platform: "twitter", location: "china" },
        })
      );
    });
  });

  describe("cleanupOld", () => {
    it("deletes vectors older than retention days", async () => {
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const oldItem = { ...makeTrend("Old"), timestamp: new Date(oldTimestamp).toISOString() };

      vectorize.query.mockResolvedValue({
        matches: [
          { id: "old-id", score: 0, metadata: { item: JSON.stringify(oldItem), timestamp_ms: oldTimestamp } },
        ],
      });

      await store.cleanupOld(30);

      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["old-id"]);
    });

    it("skips deletion when nothing is expired", async () => {
      const recentItem = makeTrend("Recent");
      vectorize.query.mockResolvedValue({
        matches: [
          { id: "recent-id", score: 0, metadata: { item: JSON.stringify(recentItem), timestamp_ms: Date.now() } },
        ],
      });

      await store.cleanupOld(30);

      expect(vectorize.deleteByIds).not.toHaveBeenCalled();
    });
  });
});
