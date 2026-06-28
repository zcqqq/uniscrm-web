import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

export function createRecommendationsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const service = new RecommendService(c.env.WEB_DB, c.env.VECTORIZE, c.env.KV);
    const recommendations = await service.getForTenant(tenantId);
    return c.json({ recommendations });
  });

  return router;
}
