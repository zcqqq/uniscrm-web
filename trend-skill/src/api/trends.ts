import { Hono } from "hono";
import type { Env, TrendItem } from "../types";

export function createTrendsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/trends", async (c) => {
    const location = c.req.query("location");
    const language = c.req.query("language");
    const platform = c.req.query("platform");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);

    const raw = await c.env.TREND_KV.get("trends:latest");
    let items: TrendItem[] = raw ? JSON.parse(raw) : [];

    if (location) items = items.filter((t) => t.location === location);
    if (language) items = items.filter((t) => t.language === language);
    if (platform) items = items.filter((t) => t.platform === platform);

    return c.json({ items: items.slice(0, limit) });
  });

  return router;
}
