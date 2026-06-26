import { Hono } from "hono";
import type { Env } from "./types";
import { ProductService } from "./services/product";
import { ProductLimitService } from "./services/limit";
import { fetchShopifyProducts, parseProductUrl, buildLinkItem } from "./channels/shopify";

export function productsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const service = new ProductService(c.env.LINK_DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(memberId);
    return c.json({ items });
  });

  router.delete("/:id", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const id = c.req.param("id");
    const service = new ProductService(c.env.LINK_DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, memberId);
    return c.json({ ok: true });
  });

  router.post("/sync", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const body = await c.req.json<{ product_ids: string[]; confirmed?: boolean }>();
    const { product_ids } = body;

    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'SHOPIFY' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ error: "Shopify not connected" }, 401);
    const config = JSON.parse(ch.config) as { access_token: string; channel_name: string };
    if (!config.channel_name) return c.json({ error: "Shopify not connected" }, 401);

    const limitService = new ProductLimitService(c.env.LINK_DB, c.env.VECTORIZE);
    const check = await limitService.checkLimit(memberId, product_ids.length);
    if (!check.allowed && !body.confirmed) {
      return c.json({ needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
    }
    if (!check.allowed && body.confirmed) {
      await limitService.enforceLimit(memberId, check.overflow);
    }

    const allProducts = await fetchShopifyProducts(config.channel_name, config.access_token);
    const selectedIds = new Set(product_ids);
    const selected = allProducts.filter((p) => selectedIds.has(p.channel_source_id));

    const service = new ProductService(c.env.LINK_DB, c.env.VECTORIZE, c.env.AI);
    const result = await service.syncBatch(memberId, "SHOPIFY", selected);
    return c.json(result);
  });

  router.post("/link/add", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const body = await c.req.json<{ title: string; url: string; confirmed?: boolean }>();
    const { title, url } = body;
    if (!title || !url) return c.json({ error: "title and url are required" }, 400);

    const limitService = new ProductLimitService(c.env.LINK_DB, c.env.VECTORIZE);
    const check = await limitService.checkLimit(memberId, 1);
    if (!check.allowed && !body.confirmed) {
      return c.json({ needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
    }
    if (!check.allowed && body.confirmed) {
      await limitService.enforceLimit(memberId, check.overflow);
    }

    const parsed = await parseProductUrl(url);
    const item = buildLinkItem(title, url, parsed);

    const service = new ProductService(c.env.LINK_DB, c.env.VECTORIZE, c.env.AI);
    const product = await service.addSingle(memberId, "LINK", item);
    return c.json({ product });
  });

  return router;
}
