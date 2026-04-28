import { Hono } from "hono";
import type { Env } from "../types";
import { ContentService } from "../services/content";
import { RecommendService } from "../services/recommend";

export function createContentsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/import", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { items } = await c.req.json<{
      items: { filename: string; title: string; summary: string | null; file_modified_at: string | null }[];
    }>();

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: "Items array is required" }, 400);
    }
    for (const item of items) {
      if (!item.filename || !item.title) {
        return c.json({ error: "Each item must have filename and title" }, 400);
      }
    }

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const results = await service.importBatch(userId, items);

    const recommend = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
    await recommend.computeForUser(userId);

    return c.json({ items: results });
  });

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(userId);
    return c.json({ items });
  });

  router.patch("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");
    const fields = await c.req.json<{ title?: string; summary?: string; status?: string }>();

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.update(id, userId, fields);
    return c.json({ ok: true });
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, userId);
    return c.json({ ok: true });
  });

  return router;
}
