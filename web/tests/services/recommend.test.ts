import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecommendService } from "../../worker/services/recommend";

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
    it("fetches content vectors, queries trends, and caches results", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: [{ id: "c1", user_id: "u1", title: "My Post" }],
          }),
        }),
      });
      vectorize.getByIds.mockResolvedValue([
        { id: "c1", values: [0.1, 0.2, 0.3] },
      ]);
      vectorize.query.mockResolvedValue({
        matches: [
          { id: "t1", score: 0.92, metadata: { type: "trend", title: "AI Trend", platform: "twitter", location: "global" } },
        ],
      });

      await service.computeForUser("u1");

      expect(vectorize.query).toHaveBeenCalledWith(
        [0.1, 0.2, 0.3],
        expect.objectContaining({
          filter: { type: "trend", location: "global" },
          topK: 5,
          returnMetadata: "all",
        })
      );
      expect(kv.put).toHaveBeenCalledWith(
        "recommendations:u1",
        expect.stringContaining('"content_id":"c1"')
      );
    });

    it("skips users with no content", async () => {
      await service.computeForUser("u1");
      expect(vectorize.query).not.toHaveBeenCalled();
    });
  });

  describe("getForUser", () => {
    it("returns cached recommendations sorted by best match", async () => {
      kv.get.mockResolvedValue(
        JSON.stringify([
          { content_id: "c1", title: "Post A", matches: [{ trend_id: "t1", title: "T", platform: "twitter", location: "global", similarity: 0.85 }] },
          { content_id: "c2", title: "Post B", matches: [{ trend_id: "t2", title: "T2", platform: "twitter", location: "global", similarity: 0.95 }] },
        ])
      );

      const results = await service.getForUser("u1");
      expect(results[0].content_id).toBe("c2");
    });
  });
});
