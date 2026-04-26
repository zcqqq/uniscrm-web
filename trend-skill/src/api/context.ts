import { Hono } from "hono";
import type { Env, TrendItem, WriteFormat } from "../types";
import { TrendCache } from "../storage/cache";
import { renderTemplate, getTemplate } from "../core/templates";

const VALID_FORMATS: WriteFormat[] = ["tweet", "thread", "article", "summary", "headline"];

export function createContextRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/write-context", async (c) => {
    const format = c.req.query("format") as WriteFormat | undefined;
    if (!format || !VALID_FORMATS.includes(format)) {
      return c.json({ error: "Missing or invalid format parameter" }, 400);
    }

    const trendIdsRaw = c.req.query("trendIds");
    const tone = c.req.query("tone");
    const locale = c.req.query("locale") ?? "zh-CN";
    const audience = c.req.query("audience");

    const cache = new TrendCache(c.env.TREND_KV);
    const allTrends = await cache.getLatest();

    let trends: TrendItem[];
    if (trendIdsRaw) {
      const ids = new Set(trendIdsRaw.split(","));
      trends = (allTrends ?? []).filter((t) => ids.has(t.id));
    } else {
      trends = (allTrends ?? []).slice(0, 5);
    }

    const template = renderTemplate(format, trends, {
      tone: tone ?? undefined,
      locale,
      audience: audience ?? undefined,
    });

    return c.json({
      trends,
      template,
      format,
      locale,
    });
  });

  return router;
}
