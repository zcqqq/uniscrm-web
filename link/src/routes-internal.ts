import { Hono } from "hono";
import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { CreditService, getActiveSubscriptionTier } from "../../shared/credit-service";
import { EventMetadata_X } from "../../metadata/x";
import { dollarsToMicros } from "../../shared/credit";
import { ContentService } from "./services/content";
import { createPost, repostPost } from "./services/x-posts-api";

const ACTION_TO_EVENT_TYPE: Record<string, string> = {
  follow: "follow-user",
  unfollow: "unfollow-user",
  "create-dm": "create-dm",
  "mute-user": "mute-user",
};

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // X actions: follow/unfollow/create-dm/mute-user
  router.post("/x/action", async (c) => {
    const { channelId, targetUserId, action, messageText, flowId } = await c.req.json<{
      channelId: string; targetUserId: string; action: string; messageText?: string; flowId?: string | null;
    }>();
    if (!channelId || !targetUserId || !action) {
      return c.json({ error: "channelId, targetUserId, action required" }, 400);
    }

    const channel = await c.env.LINK_DB.prepare("SELECT config, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; tenant_id: number }>();
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const config = JSON.parse(channel.config);
    const sourceUserId = config.x_user_id;
    if (!sourceUserId) return c.json({ error: "Channel has no X user ID" }, 400);

    // Credit only applies to non-BYOK channels; BYOK channels use the customer's own X API credentials.
    const isByok = !!config.is_byok;
    const eventType = ACTION_TO_EVENT_TYPE[action];
    const priceUsd = EventMetadata_X.find((m) => m.eventType === eventType)?.price ?? 0;
    const creditMicros = dollarsToMicros(priceUsd);

    if (!isByok && creditMicros > 0) {
      const sub = await getActiveSubscriptionTier(c.env.ADMIN_DB, channel.tenant_id);
      if (!sub) {
        return c.json({ ok: false, insufficientCredit: true, error: "No active paid subscription" }, 402);
      }
      const creditSvc = new CreditService(c.env.ADMIN_DB);
      const balance = await creditSvc.getBalance(channel.tenant_id, sub.tier, sub.createdAt);
      if (balance.balanceMicros <= 0) {
        console.log(JSON.stringify({ event: "xaction_insufficient_credit", tenantId: channel.tenant_id, channelId, action, balanceMicros: balance.balanceMicros }));
        return c.json({ ok: false, insufficientCredit: true }, 402);
      }
    }

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

    console.log(JSON.stringify({ event: "x_action_executed", action, sourceUserId, targetUserId, status: xRes.status, rateLimitRemaining, rateLimitReset, response: xBody }));

    // Deduct credit only after a successful (2xx) paid API call, and only for non-BYOK channels.
    if (xRes.ok && !isByok && creditMicros > 0) {
      const creditSvc = new CreditService(c.env.ADMIN_DB);
      await creditSvc.logUsage({
        tenantId: channel.tenant_id,
        flowId: flowId ?? null,
        channelId,
        actionEventType: eventType,
        creditMicros,
      });
    }

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

  // Create X channel (called by web worker during X sign-up/login)
  router.post("/channels/create-x", async (c) => {
    const { tenant_id, member_id, access_token, refresh_token, expires_at } = await c.req.json<{
      tenant_id: number; member_id: string; access_token: string; refresh_token: string | null; expires_at: string;
    }>();
    if (!tenant_id || !member_id || !access_token) {
      return c.json({ error: "tenant_id, member_id, access_token required" }, 400);
    }

    const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) return c.json({ error: "Failed to fetch X user info" }, 502);
    const userData = await userRes.json() as { data: { id: string; name: string; username: string; profile_image_url?: string } };
    const xUser = userData.data;

    const config = JSON.stringify({
      x_user_id: xUser.id,
      x_username: xUser.username,
      x_name: xUser.name,
      access_token,
      refresh_token,
      expires_at,
    });

    const channelId = crypto.randomUUID();
    await c.env.LINK_DB
      .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'X', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`)
      .bind(channelId, config, xUser.id, access_token, tenant_id, member_id)
      .run();

    const row = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE channel_type = 'X' AND source_channel_id = ? AND is_active = 1")
      .bind(xUser.id)
      .first<{ id: string }>();
    const actualChannelId = row?.id || channelId;

    const url = new URL(c.req.url);
    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    try {
      const webhookUrl = `${url.origin}/x/webhook`;
      const bearerService = new XActivityService(c.env.X_BEARER_TOKEN);
      let webhook = await bearerService.getWebhook();
      if (!webhook || webhook.url !== webhookUrl) {
        const whId = await bearerService.createWebhook(webhookUrl);
        webhook = { webhook_id: whId, url: webhookUrl };
      }
      const userService = new XActivityService(access_token);
      const ids = await userService.setupAllSubscriptions(xUser.id, webhookUrl, webhook.webhook_id);
      await tokenService.updateConfig(actualChannelId, { subscription_ids: ids });
    } catch (e) {
      console.error("XAA subscription setup failed:", e);
    }

    return c.json({ channel_id: actualChannelId });
  });

  // Reposts contentId's originating tweet via the channel that ingested it. channelId is
  // always the flow's triggering channel (never a user-picked target) — the Repost Operation
  // has no account picker. tweetId comes from the flow engine's payload.source_content_id.
  router.post("/x/repost", async (c) => {
    const { channelId, contentId, tweetId, flowId } = await c.req.json<{
      channelId: string; contentId: string; tweetId: string; flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB.prepare("SELECT config, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; tenant_id: number }>();
    if (!channel) return c.json({ ok: false }, 200);

    const config = JSON.parse(channel.config);
    const sourceUserId = config.x_user_id;
    if (!sourceUserId) return c.json({ ok: false }, 200);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);
    const repostResult = await repostPost(accessToken, sourceUserId, tweetId);

    console.log(JSON.stringify({ event: "x_repost", contentId, channelId, flowId: flowId || null, ok: repostResult.ok, rateLimited: !!repostResult.rateLimited }));

    if (repostResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    return c.json({ ok: repostResult.ok });
  });

  // Real X publish path: content's generated (or literal, for provider:"none") text gets
  // posted to the target channel. TikTok publish is out of scope this phase (see design
  // spec's non-goals) — targetChannelId resolving to a TIKTOK channel_type falls through
  // to the generic ok:false path below.
  router.post("/content/create-post", async (c) => {
    const { contentId, interpolatedPrompt, provider, targetChannelId, flowId, skillId } = await c.req.json<{
      contentId: string; interpolatedPrompt: string; provider: "default" | "openai" | "anthropic" | "none"; targetChannelId: string; flowId?: string | null; skillId?: string;
    }>();

    const targetChannel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(targetChannelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!targetChannel) return c.json({ ok: false }, 200);

    if (targetChannel.channel_type !== "X") {
      console.log(JSON.stringify({ event: "create_post_unsupported_platform", contentId, targetChannelId, channelType: targetChannel.channel_type }));
      return c.json({ ok: false }, 200);
    }

    let text = interpolatedPrompt;
    if (provider !== "none") {
      const genRes = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId: targetChannel.tenant_id, prompt: interpolatedPrompt, provider, skillId }),
      });
      if (!genRes.ok) {
        console.error(JSON.stringify({ event: "create_post_generate_failed", contentId, targetChannelId, provider, status: genRes.status }));
        return c.json({ ok: false }, 200);
      }
      const generated = await genRes.json<{ text: string }>();
      text = generated.text;
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(targetChannel.tenant_id).first<{ d1_database_id: string | null }>();
    if (!tenantRow?.d1_database_id) return c.json({ ok: false }, 200);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(targetChannelId);
    const postResult = await createPost(accessToken, text);

    console.log(JSON.stringify({ event: "create_post_x_post", contentId, targetChannelId, provider, ok: postResult.ok, rateLimited: !!postResult.rateLimited }));

    if (postResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!postResult.ok || !postResult.id) {
      return c.json({ ok: false }, 200);
    }

    const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, targetChannel.tenant_id);
    await contentService.recordPublishedContent(targetChannelId, "X", postResult.id, text, {
      generatedFromContentId: contentId,
      flowId: flowId || "",
    });

    return c.json({ ok: true });
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
