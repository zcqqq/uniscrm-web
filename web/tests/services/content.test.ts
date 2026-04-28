import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService } from "../../worker/services/content";

describe("ContentService", () => {
  let db: any;
  let vectorize: any;
  let ai: any;
  let service: ContentService;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({}),
        }),
      }),
    };
    vectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
      getByIds: vi.fn().mockResolvedValue([]),
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };
    service = new ContentService(db, vectorize, ai);
  });

  describe("importBatch", () => {
    it("inserts content into D1 and upserts embedding into Vectorize", async () => {
      const items = [
        { filename: "post.md", title: "post.md — My Post", summary: "A summary", file_modified_at: "2026-04-28T00:00:00Z" },
      ];

      const results = await service.importBatch("user-1", items);

      expect(results).toHaveLength(1);
      expect(db.prepare).toHaveBeenCalled();
      expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
        text: ["post.md — My Post | A summary"],
      });
      expect(vectorize.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          metadata: expect.objectContaining({
            type: "content",
            user_id: "user-1",
          }),
        }),
      ]);
    });
  });

  describe("listByUser", () => {
    it("queries D1 for user contents sorted by file_modified_at desc", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: [{ id: "c1", user_id: "user-1", filename: "a.md", title: "A", status: "new" }],
          }),
        }),
      });

      const results = await service.listByUser("user-1");
      expect(results).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates title and re-embeds when title changes", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "Old", summary: "Sum" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.update("c1", "user-1", { title: "New Title" });

      expect(ai.run).toHaveBeenCalled();
      expect(vectorize.upsert).toHaveBeenCalled();
    });

    it("updates status without re-embedding", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "T", summary: "S" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.update("c1", "user-1", { status: "published" });

      expect(ai.run).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes from D1 and Vectorize", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.delete("c1", "user-1");

      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["c1"]);
    });
  });
});
