import { Hono } from "hono";
import type { Env } from "../types";
import { ProductService } from "../services/product";

export function createProductsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(userId);
    return c.json({ items });
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");
    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, userId);
    return c.json({ ok: true });
  });

  return router;
}
