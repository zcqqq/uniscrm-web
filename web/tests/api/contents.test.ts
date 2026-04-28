import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createContentsRouter } from "../../worker/api/contents";

describe("content routes", () => {
  let db: any;
  let vectorize: any;
  let ai: any;
  let app: Hono;

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
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { DB: db, VECTORIZE: vectorize, AI: ai, KV: {} };
      c.set("userId" as never, "user-1");
      return next();
    });
    app.route("/contents", createContentsRouter());
  });

  describe("POST /contents/import", () => {
    it("imports content items", async () => {
      const res = await app.request("/contents/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ filename: "test.md", title: "test.md — Test", summary: "Hello", file_modified_at: null }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
    });
  });

  describe("GET /contents", () => {
    it("lists user content", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [{ id: "c1", title: "T" }] }),
        }),
      });
      const res = await app.request("/contents");
      expect(res.status).toBe(200);
    });
  });

  describe("PATCH /contents/:id", () => {
    it("updates content status", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "T", summary: "S" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });
      const res = await app.request("/contents/c1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /contents/:id", () => {
    it("deletes content", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
        }),
      });
      const res = await app.request("/contents/c1", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });
});
