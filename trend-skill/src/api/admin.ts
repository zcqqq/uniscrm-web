import { Hono } from "hono";
import type { Env } from "../types";
import { ApiKeyService } from "../auth/keys";

export function createAdminRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.use("*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  router.post("/keys", async (c) => {
    const body = await c.req.json<{ tier?: string; owner_name?: string }>();
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = await service.create(
      (body.tier as "free" | "premium") ?? "free",
      body.owner_name
    );
    return c.json(key, 201);
  });

  router.get("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = await service.get(c.req.param("key"));
    if (!key) return c.json({ error: "Not found" }, 404);
    return c.json(key);
  });

  router.patch("/keys/:key", async (c) => {
    const body = await c.req.json<{ tier?: string; is_active?: boolean }>();
    const service = new ApiKeyService(c.env.TREND_DB);

    if (body.tier) await service.updateTier(c.req.param("key"), body.tier as "free" | "premium");
    if (body.is_active === false) await service.deactivate(c.req.param("key"));

    const updated = await service.get(c.req.param("key"));
    return c.json(updated);
  });

  router.delete("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    await service.delete(c.req.param("key"));
    return c.json({ deleted: true });
  });

  return router;
}
