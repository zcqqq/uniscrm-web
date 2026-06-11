import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

export function createRecommendationsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const service = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
    const recommendations = await service.getForUser(memberId);
    return c.json({ recommendations });
  });

  return router;
}
