import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, Session } from "../types";
import { OAuthService } from "../services/oauth";
import { ProductService } from "../services/product";
import { LimitService } from "../services/limit";
import {
  buildShopifyAuthUrl,
  exchangeShopifyCode,
  fetchShopifyProducts,
} from "../channels/shopify";
import { parseProductUrl, buildLinkItem } from "../channels/link";

export function createChannelsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/shopify/auth", async (c) => {
    const { shop } = c.req.query();
    if (!shop) {
      return c.json({ error: "Missing shop parameter" }, 400);
    }
    const sessionId = getCookie(c, "session") ?? "";
    const url = buildShopifyAuthUrl(
      shop,
      c.env.SHOPIFY_CLIENT_ID,
      c.env.SHOPIFY_REDIRECT_URI,
      sessionId
    );
    return c.json({ url });
  });

  router.get("/shopify/status", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token) {
      return c.json({ connected: false });
    }
    return c.json({ connected: true, channel_name: token.channel_name });
  });

  router.get("/shopify/products", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token || !token.channel_name) {
      return c.json({ error: "Shopify not connected" }, 401);
    }
    const products = await fetchShopifyProducts(token.channel_name, token.access_token);
    return c.json({ products });
  });

  router.post("/shopify/sync", async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = await c.req.json<{ product_ids: string[]; confirmed?: boolean }>();
    const { product_ids } = body;

    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token || !token.channel_name) {
      return c.json({ error: "Shopify not connected" }, 401);
    }

    const limitService = new LimitService(c.env.DB, c.env.VECTORIZE);
    const check = await limitService.checkLimit(userId, product_ids.length);

    if (!check.allowed && !body.confirmed) {
      return c.json({
        needsConfirmation: true,
        overflow: check.overflow,
        wouldDelete: check.wouldDelete,
      });
    }

    if (!check.allowed && body.confirmed) {
      await limitService.enforceLimit(userId, check.overflow);
    }

    const allProducts = await fetchShopifyProducts(token.channel_name, token.access_token);
    const selectedIds = new Set(product_ids);
    const selected = allProducts.filter((p) => selectedIds.has(p.channel_source_id));

    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const result = await service.syncBatch(userId, "SHOPIFY", selected);
    return c.json(result);
  });

  router.post("/link/add", async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = await c.req.json<{ title: string; url: string; confirmed?: boolean }>();
    const { title, url } = body;

    if (!title || !url) {
      return c.json({ error: "title and url are required" }, 400);
    }

    const limitService = new LimitService(c.env.DB, c.env.VECTORIZE);
    const check = await limitService.checkLimit(userId, 1);

    if (!check.allowed && !body.confirmed) {
      return c.json({
        needsConfirmation: true,
        overflow: check.overflow,
        wouldDelete: check.wouldDelete,
      });
    }

    if (!check.allowed && body.confirmed) {
      await limitService.enforceLimit(userId, check.overflow);
    }

    const parsed = await parseProductUrl(url);
    const item = buildLinkItem(title, url, parsed);

    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const product = await service.addSingle(userId, "LINK", item);
    return c.json({ product });
  });

  return router;
}

export function createShopifyCallbackRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/shopify/callback", async (c) => {
    const code = c.req.query("code");
    const shop = c.req.query("shop");
    const state = c.req.query("state");

    if (!code || !shop || !state) {
      return c.json({ error: "Missing code, shop, or state" }, 400);
    }

    const data = await c.env.KV.get(`session:${state}`);
    if (!data) {
      return c.json({ error: "Invalid session" }, 401);
    }
    const session = JSON.parse(data) as Session;

    const tokenData = await exchangeShopifyCode(
      shop,
      c.env.SHOPIFY_CLIENT_ID,
      c.env.SHOPIFY_CLIENT_SECRET,
      code
    );

    const oauth = new OAuthService(c.env.DB);
    await oauth.saveToken(session.user_id, "shopify", {
      access_token: tokenData.access_token,
      channel_name: shop,
    });

    return c.redirect("/?shopify=connected");
  });

  return router;
}
