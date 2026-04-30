import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecommendService, cosineSimilarity } from "../../worker/services/recommend";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns value between 0 and 1 for partially similar vectors", () => {
    const s = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});

describe("RecommendService", () => {
  let db: any;
  let vectorize: any;
  let kv: any;
  let service: RecommendService;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    vectorize = {
      getByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    };
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    };
    service = new RecommendService(db, vectorize, kv);
  });

  describe("computeForUser", () => {
    it("queries content and product for each trend, caches results", async () => {
      const trendsJson = JSON.stringify([
        { id: "t1", title: "AI Trend", platform: "twitter", location: "global", score: 100 },
      ]);
      kv.get.mockImplementation((key: string) => {
        if (key === "trends:latest") return trendsJson;
        return null;
      });

      vectorize.getByIds.mockResolvedValue([
        { id: "t1", values: [1, 0, 0] },
      ]);

      let queryCount = 0;
      vectorize.query.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return { matches: [{ id: "c1", score: 0.9, metadata: { title: "Content A", user_id: "u1" } }] };
        }
        return { matches: [{ id: "p1", score: 0.8, metadata: { title: "Product A", user_id: "u1" } }] };
      });

      // For the content↔product cosine calc — use orthogonal vectors so s_cp is low
      vectorize.getByIds
        .mockResolvedValueOnce([{ id: "t1", values: [1, 0, 0] }])
        .mockResolvedValueOnce([{ id: "c1", values: [1, 0, 0] }, { id: "p1", values: [0, 1, 0] }]);

      await service.computeForUser("u1", "global");

      expect(kv.put).toHaveBeenCalledWith(
        "recommendations:u1",
        expect.any(String)
      );
      const cached = JSON.parse(kv.put.mock.calls[0][1]);
      expect(cached.length).toBe(1);
      expect(cached[0]).toHaveProperty("sort_score");
      expect(cached[0]).toHaveProperty("trend");
    });

    it("skips when no trends in KV", async () => {
      await service.computeForUser("u1", "global");
      expect(vectorize.query).not.toHaveBeenCalled();
    });

    it("handles trend with only content match", async () => {
      kv.get.mockImplementation((key: string) => {
        if (key === "trends:latest") return JSON.stringify([
          { id: "t1", title: "T", platform: "twitter", location: "global", score: 50 },
        ]);
        return null;
      });
      vectorize.getByIds.mockResolvedValue([{ id: "t1", values: [1, 0] }]);
      vectorize.query
        .mockResolvedValueOnce({ matches: [{ id: "c1", score: 0.7, metadata: { title: "C", user_id: "u1" } }] })
        .mockResolvedValueOnce({ matches: [] });

      await service.computeForUser("u1", "global");

      const cached = JSON.parse(kv.put.mock.calls[0][1]);
      expect(cached[0].trend).toBeDefined();
      expect(cached[0].content).toBeDefined();
      expect(cached[0].product).toBeUndefined();
    });
  });

  describe("getForUser", () => {
    it("returns cached recommendations", async () => {
      kv.get.mockResolvedValue(
        JSON.stringify([
          { trend: { id: "t1", title: "T", platform: "tw", score: 100, similarity: 0.9 }, sort_score: 0.85 },
        ])
      );

      const results = await service.getForUser("u1");
      expect(results).toHaveLength(1);
      expect(results[0].sort_score).toBe(0.85);
    });
  });
});
