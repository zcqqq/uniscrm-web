import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrendVectorStore } from "../../src/storage/vectorize";
import type { TrendItem } from "../../src/types";

const sampleTrend: TrendItem = {
  id: "twitter:1",
  platform: "twitter",
  title: "AI Breakthroughs",
  description: "Major AI advances",
  url: "https://x.com/trend/1",
  score: 95,
  rawMetrics: { tweet_volume: 50000 },
  categories: ["technology"],
  timestamp: new Date().toISOString(),
};

function createMockAI() {
  return {
    run: vi.fn(async () => ({
      data: [[0.1, 0.2, 0.3, 0.4]],
    })),
  } as unknown as Ai;
}

function createMockVectorize() {
  return {
    upsert: vi.fn(async () => ({ count: 1 })),
    query: vi.fn(async () => ({
      matches: [
        {
          id: "twitter:1",
          score: 0.95,
          metadata: { item: JSON.stringify(sampleTrend) },
        },
      ],
    })),
    deleteByIds: vi.fn(async () => ({ count: 1 })),
  } as unknown as VectorizeIndex;
}

describe("TrendVectorStore", () => {
  let store: TrendVectorStore;
  let mockAI: Ai;
  let mockVectorize: VectorizeIndex;

  beforeEach(() => {
    mockAI = createMockAI();
    mockVectorize = createMockVectorize();
    store = new TrendVectorStore(mockVectorize, mockAI);
  });

  it("upserts trends with embeddings", async () => {
    await store.upsertTrends([sampleTrend]);

    expect(mockAI.run).toHaveBeenCalledOnce();
    expect(mockVectorize.upsert).toHaveBeenCalledOnce();

    const upsertArg = (mockVectorize.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertArg[0].id).toBe("twitter:1");
    expect(upsertArg[0].values).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("searches by semantic query and returns TrendSearchResult[]", async () => {
    const results = await store.search("AI technology");

    expect(mockAI.run).toHaveBeenCalledOnce();
    expect(mockVectorize.query).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0].item.id).toBe("twitter:1");
    expect(results[0].similarity).toBe(0.95);
  });

  it("builds embedding text from title, description, and categories", () => {
    const text = store.buildEmbeddingText(sampleTrend);
    expect(text).toBe("AI Breakthroughs | Major AI advances | technology");
  });

  it("builds embedding text without description when absent", () => {
    const noDesc = { ...sampleTrend, description: undefined, categories: [] };
    const text = store.buildEmbeddingText(noDesc);
    expect(text).toBe("AI Breakthroughs");
  });
});
