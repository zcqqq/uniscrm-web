import { Hono } from "hono";
import type { Env, Tier } from "../types";
import { ApiKeyService } from "../auth/keys";

export function createAdminRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  router.post("/keys", async (c) => {
    const body = await c.req.json<{ tier?: Tier; owner_name?: string }>();
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = await service.create(body.tier ?? "free", body.owner_name);
    return c.json({ key }, 201);
  });

  router.get("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    const record = await service.get(c.req.param("key"));
    if (!record) return c.json({ error: "Key not found" }, 404);
    return c.json(record);
  });

  router.patch("/keys/:key", async (c) => {
    const body = await c.req.json<{ tier?: Tier; deactivate?: boolean }>();
    const service = new ApiKeyService(c.env.TREND_DB);
    const key = c.req.param("key");

    if (body.tier) await service.updateTier(key, body.tier);
    if (body.deactivate) await service.deactivate(key);

    return c.json({ success: true });
  });

  router.delete("/keys/:key", async (c) => {
    const service = new ApiKeyService(c.env.TREND_DB);
    await service.delete(c.req.param("key"));
    return c.json({ success: true });
  });

  return router;
}
