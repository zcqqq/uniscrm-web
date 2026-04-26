import { Hono } from "hono";
import type { Env } from "../types";
import { TrendCache } from "../storage/cache";
import { TrendVectorStore } from "../storage/vectorize";

export function createTrendsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/trends", async (c) => {
    const query = c.req.query("query");
    const platform = c.req.query("platform");
    const limit = parseInt(c.req.query("limit") ?? "20", 10);

    if (query) {
      const vectorStore = new TrendVectorStore(c.env.TREND_VECTORIZE, c.env.AI);
      const results = await vectorStore.search(query, limit);
      return c.json({ results });
    }

    const cache = new TrendCache(c.env.TREND_KV);

    if (platform) {
      const items = await cache.getPlatformLatest(platform);
      if (!items) return c.json({ error: "No data for platform" }, 503);
      return c.json({ trends: items.slice(0, limit) });
    }

    const items = await cache.getLatest();
    if (!items) return c.json({ error: "Trend data not yet available" }, 503);
    return c.json({ trends: items.slice(0, limit) });
  });

  return router;
}
