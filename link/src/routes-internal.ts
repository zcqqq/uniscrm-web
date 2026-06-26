import { Hono } from "hono";
import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { TenantDataDB } from "../../shared/tenant-data-db";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // X actions: follow/unfollow/create-dm/mute-user
  router.post("/x/action", async (c) => {
    const { channelId, targetUserId, action, messageText } = await c.req.json<{
      channelId: string; targetUserId: string; action: string; messageText?: string;
    }>();
    if (!channelId || !targetUserId || !action) {
      return c.json({ error: "channelId, targetUserId, action required" }, 400);
    }

    const channel = await c.env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string }>();
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const config = JSON.parse(channel.config);
    const sourceUserId = config.x_user_id;
    if (!sourceUserId) return c.json({ error: "Channel has no X user ID" }, 400);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);

    let xRes: Response;
    if (action === "follow") {
      xRes = await fetch(`https://api.x.com/2/users/${sourceUserId}/following`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: targetUserId }),
      });
    } else if (action === "unfollow") {
      xRes = await fetch(`https://api.x.com/2/users/${sourceUserId}/following/${targetUserId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } else if (action === "create-dm") {
      if (!messageText) return c.json({ error: "messageText required for create-dm" }, 400);
      xRes = await fetch(`https://api.x.com/2/dm_conversations/with/${targetUserId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      });
    } else if (action === "mute-user") {
      xRes = await fetch(`https://api.x.com/2/users/${sourceUserId}/muting`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: targetUserId }),
      });
    } else {
      return c.json({ error: `Unknown action: ${action}` }, 400);
    }

    const xBody = await xRes.json();
    const rateLimitRemaining = parseInt(xRes.headers.get("x-rate-limit-remaining") || "-1", 10);
    const rateLimitResetUnix = parseInt(xRes.headers.get("x-rate-limit-reset") || "0", 10);
    const rateLimitReset = rateLimitResetUnix ? new Date(rateLimitResetUnix * 1000).toISOString() : "";

    console.log(JSON.stringify({ event: "x_action_executed", action, sourceUserId, targetUserId, status: xRes.status, rateLimitRemaining, rateLimitReset }));

    return c.json({
      ok: xRes.ok,
      status: xRes.status,
      rateLimited: xRes.status === 429,
      rateLimitRemaining,
      rateLimitReset,
      data: xBody,
    });
  });

  // Lists: add user (called by flow worker)
  router.post("/lists/:id/users", async (c) => {
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) return c.json({ error: "X-Tenant-Id required" }, 400);

    const listId = c.req.param("id");
    const body = await c.req.json<{ userId: string }>();
    if (!body.userId) return c.json({ error: "userId is required" }, 400);

    const list = await c.env.LINK_DB.prepare(
      "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
    ).bind(listId, Number(tenantId)).first();
    if (!list) return c.json({ error: "List not found" }, 404);

    await c.env.LINK_DB.prepare(
      "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
    ).bind(listId, body.userId, Number(tenantId)).run();

    return c.json({ ok: true }, 201);
  });

  // TikTok content sync (internal, no session)
  router.post("/tiktok/sync", async (c) => {
    const { ContentService } = await import("./services/content");
    const { TikTokChannel } = await import("./channels/tiktok");

    const channel = await c.env.LINK_DB
      .prepare("SELECT config, tenant_id FROM channels WHERE channel_type = 'TIKTOK' LIMIT 1")
      .first<{ config: string; tenant_id: number }>();
    if (!channel) return c.json({ error: "TikTok not connected" }, 400);

    const config = JSON.parse(channel.config) as { access_token?: string };
    if (!config.access_token) return c.json({ error: "No token" }, 400);

    const tenant = await c.env.WEB_DB
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
  });

  return router;
}
