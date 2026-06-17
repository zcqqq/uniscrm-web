import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware } from "./auth/middleware";
import { createContentsRouter } from "./api/contents";
import { createChannelsRouter, createNotionCallbackRouter } from "./api/channels";
import { TikTokChannel } from "./channels/tiktok";
import { ContentService } from "./services/content";
import { TenantDataDB } from "../../shared/tenant-data-db";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/channels", createNotionCallbackRouter());

// Internal TikTok sync (no session required, called from link-social after OAuth)
app.post("/api/internal/tiktok/sync", async (c) => {
  try {
    const channel = await c.env.DB
      .prepare(`SELECT config, tenant_id FROM channels WHERE channel_type = 'TIKTOK' LIMIT 1`)
      .first<{ config: string; tenant_id: number }>();

    if (!channel) return c.json({ error: "TikTok not connected" }, 400);

    const config = JSON.parse(channel.config) as { access_token?: string };
    if (!config.access_token) return c.json({ error: "No token" }, 400);

    const tenant = await c.env.DB
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(channel.tenant_id)
      .first<{ d1_database_id: string | null }>();

    if (!tenant?.d1_database_id) return c.json({ error: "Tenant DB not provisioned" }, 500);

    const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenant.d1_database_id);
    const tiktok = new TikTokChannel(config.access_token);
    const items = await tiktok.fetchItems({});

    if (items.length === 0) return c.json({ status: "ok", added: 0, updated: 0, skipped: 0 });

    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, channel.tenant_id);
    const result = await contentService.syncBatch("TIKTOK", items);

    return c.json({ status: "ok", ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});

app.use("/api/*", authMiddleware);

app.get("/api/auth/me", (c) => {
  return c.json({ email: c.get("email" as never) });
});

app.post("/api/auth/logout", async (c) => {
  const { getCookie, deleteCookie } = await import("hono/cookie");
  const sessionId = getCookie(c, "session");
  if (sessionId) {
    await c.env.KV.delete(`session:${sessionId}`);
    deleteCookie(c, "session");
  }
  return c.json({ ok: true });
});

app.route("/api/contents", createContentsRouter());
app.route("/api/channels", createChannelsRouter());

app.all("/*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
};
