import type { Env } from "./types";
import type { TrendSource } from "./sources/interface";
import { getTwitterConfig, getTikTokConfig, getDouyinConfig } from "./config";
import { TwitterTrendSource } from "./sources/twitter";
import { TikTokTrendSource } from "./sources/tiktok";
import { DouyinTrendSource } from "./sources/douyin";
import { Aggregator } from "./core/aggregator";
import { TrendCache } from "./storage/cache";
import { TrendVectorStore } from "./storage/vectorize";
import { XUsersService } from "./services/x-users";
import type { XUserData } from "./services/x-users";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { XWebhookService, XActivityService } from "./services/x-webhook";
import { XTokenService } from "./services/x-token";
import { Twitter, generateState, generateCodeVerifier } from "arctic";

function flattenUserPayload(userData?: Record<string, unknown>): Record<string, unknown> {
  if (!userData) return {};
  const pm = userData.public_metrics as Record<string, unknown> | undefined;
  return {
    name: String(userData.name || ""),
    username: String(userData.username || ""),
    followers_count: Number(userData.followers_count || pm?.followers_count || 0),
    following_count: Number(userData.following_count || pm?.following_count || 0),
    verified_type: String(userData.verified_type || (userData.verified ? "blue" : "none")),
  };
}

interface CronResult {
  totalItems: number;
  platforms: string[];
  failedPlatforms: string[];
}

async function handleCron(env: Env): Promise<CronResult> {
  const sources: TrendSource[] = [];

  const twitterConfig = getTwitterConfig();
  if (twitterConfig && env.TWITTER_BEARER_TOKEN) {
    sources.push(new TwitterTrendSource(env.TWITTER_BEARER_TOKEN));
  }

  const tiktokConfig = getTikTokConfig();
  if (tiktokConfig && env.FIRECRAWL_API_KEY && env.TIKTOK_COOKIE) {
    sources.push(
      new TikTokTrendSource(
        env.FIRECRAWL_API_KEY,
        env.TIKTOK_COOKIE,
        tiktokConfig.locations,
        tiktokConfig.categories
      )
    );
  }

  const douyinConfig = getDouyinConfig();
  if (douyinConfig && env.FIRECRAWL_API_KEY && env.DOUYIN_COOKIE) {
    sources.push(
      new DouyinTrendSource(
        env.FIRECRAWL_API_KEY,
        env.DOUYIN_COOKIE,
        douyinConfig.categories
      )
    );
  }

  if (sources.length === 0) {
    console.log(JSON.stringify({ event: "link-social.no_sources", message: "No sources configured or secrets missing" }));
    return { totalItems: 0, platforms: [], failedPlatforms: [] };
  }

  const aggregator = new Aggregator(sources);
  const cache = new TrendCache(env.TREND_KV);
  const vectorStore = new TrendVectorStore(env.TREND_VECTORIZE, env.AI);

  const { items, failedPlatforms } = await aggregator.fetchAll();

  if (failedPlatforms.length > 0) {
    console.log(
      JSON.stringify({
        event: "link-social.fetch_partial_failure",
        failedPlatforms,
        successCount: items.length,
      })
    );
  }

  await cache.setLatest(items);

  const byKey = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.platform}:${item.location}`;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  for (const [key, platformItems] of byKey) {
    const [platform, location] = key.split(":");
    await cache.setPlatformLatest(platform, location, platformItems);
  }

  await vectorStore.upsertTrends(items);

  const retentionDays = parseInt(env.TREND_RETENTION_DAYS || "30", 10);
  await vectorStore.cleanupOld(retentionDays);

  const result: CronResult = {
    totalItems: items.length,
    platforms: [...new Set(items.map((i) => i.platform))],
    failedPlatforms,
  };

  console.log(JSON.stringify({ event: "link-social.cron_complete", ...result }));
  return result;
}

async function handleXActivityEvent(body: Record<string, unknown>, env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "xaa_webhook_received", body }));

  // XAA webhook payload — try both { data: {...} } and top-level format
  const data = (body["data"] || body) as {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: Record<string, unknown>;
    tag?: string;
  };

  const eventType = data.event_type;
  const filterUserId = data.filter?.user_id;
  const payload = data.payload || {};

  if (!eventType || !filterUserId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_match", eventType, filterUserId, keys: Object.keys(body) }));
    return;
  }

  const channelInfo = await findChannelByXUserId(env.DB, filterUserId);
  if (!channelInfo) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_channel", filterUserId }));
    return;
  }
  const { channelId, tenantId, d1DatabaseId } = channelInfo;

  if (!d1DatabaseId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_tenant_db", filterUserId, tenantId }));
    return;
  }

  const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, d1DatabaseId);
  const usersService = new XUsersService(tenantDb, env.MAIGRET_QUEUE);

  // Follow events: payload has { source: { data: {...} }, target: { data: {...} } }
  if (eventType === "follow.follow" || eventType === "follow.unfollow") {
    const source = payload.source as { data?: Record<string, unknown> } | undefined;
    const target = payload.target as { data?: Record<string, unknown> } | undefined;
    const sourceId = source?.data?.id as string | undefined;
    const targetId = target?.data?.id as string | undefined;

    if (sourceId === filterUserId && target?.data) {
      // Channel followed/unfollowed someone → record the target user
      const userData = target.data;
      await usersService.upsertUser({
        id: userData.id as string,
        name: userData.name as string | undefined,
        username: userData.username as string | undefined,
        profile_image_url: userData.profile_image_url as string | undefined,
      });
      const resolvedEventType = eventType === "follow.follow" ? "follow.follow" : "follow.unfollow";
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);

      if (tenantId) {
        await env.FLOW_QUEUE.send({
          tenantId,
          eventType: resolvedEventType,
          userId: userData.id as string,
          channelId,
          payload: flattenUserPayload(userData),
        });
      }
      console.log(JSON.stringify({ event: "xaa_event_processed", eventType: resolvedEventType, userId: userData.id }));
    } else if (targetId === filterUserId && source?.data) {
      // Someone followed/unfollowed the channel → record the source user
      const userData = source.data;
      await usersService.upsertUser({
        id: userData.id as string,
        name: userData.name as string | undefined,
        username: userData.username as string | undefined,
        profile_image_url: userData.profile_image_url as string | undefined,
      });
      const resolvedEventType = eventType === "follow.follow" ? "follow.followed" : "follow.unfollowed";
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);

      if (tenantId) {
        await env.FLOW_QUEUE.send({
          tenantId,
          eventType: resolvedEventType,
          userId: userData.id as string,
          channelId,
          payload: flattenUserPayload(userData),
        });
      }
      console.log(JSON.stringify({ event: "xaa_event_processed", eventType: resolvedEventType, userId: userData.id }));
    }
    return;
  }

  // For chat/dm events: upsert the sender
  if (eventType.startsWith("chat.") || eventType.startsWith("dm.")) {
    const senderId = payload.sender_id as string | undefined
      || payload.user_id as string | undefined
      || payload.id as string | undefined;
    if (senderId && senderId !== filterUserId) {
      await usersService.upsertUser({
        id: senderId,
        username: payload.sender_username as string | undefined || payload.username as string | undefined,
        name: payload.sender_name as string | undefined || payload.name as string | undefined,
        profile_image_url: payload.sender_profile_image_url as string | undefined || payload.profile_image_url as string | undefined,
      });
    }
  }

  // Post events → write to content table
  if (eventType === "post.create") {
    const tweetId = payload.id as string;
    const text = payload.text as string || "";
    if (tweetId) {
      const shareUrl = `https://x.com/i/web/status/${tweetId}`;
      await tenantDb.run(
        `INSERT INTO content (id, channel_type, channel_id, source_content_id, title, summary, status, source_url, raw_data, created_at, updated_at)
         VALUES (?, 'X', ?, ?, ?, NULL, 'new', ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(channel_id, source_content_id) DO UPDATE SET title = excluded.title, raw_data = excluded.raw_data, updated_at = datetime('now')`,
        [crypto.randomUUID(), channelId, tweetId, text.slice(0, 200), shareUrl, JSON.stringify(payload)]
      );
    }
  }

  if (eventType === "post.delete") {
    const tweetId = payload.id as string || payload.tweet_id as string;
    if (tweetId) {
      await tenantDb.run(
        `UPDATE content SET status = 'deleted', updated_at = datetime('now') WHERE channel_id = ? AND source_content_id = ?`,
        [channelId, tweetId]
      );
    }
  }

  // Record non-follow events uniformly
  const eventUserId = (eventType.startsWith("chat.") || eventType.startsWith("dm."))
    ? (payload.sender_id as string || payload.user_id as string || payload.id as string || filterUserId)
    : filterUserId;

  await usersService.insertEvents([{
    userId: eventUserId,
    channelId,
    eventType,
    eventTime: new Date().toISOString(),
    rawData: payload,
  }]);

  console.log(JSON.stringify({ event: "xaa_event_processed", eventType, userId: eventUserId }));
}

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function resolveTenantDataDb(request: Request, env: Env): Promise<TenantDataDB | null> {
  const sessionId = getCookieValue(request, "session");
  if (!sessionId) return null;
  const sessionData = await env.TREND_KV.get(`session:${sessionId}`);
  if (!sessionData) return null;
  const session = JSON.parse(sessionData) as { tenant_id?: string; member_id?: string; user_id?: string };
  const tenantId = session.tenant_id || session.user_id;
  if (!tenantId) return null;
  const row = await env.DB.prepare("SELECT d1_database_id FROM tenants WHERE id = ?")
    .bind(tenantId).first<{ d1_database_id: string | null }>();
  if (!row?.d1_database_id) return null;
  return new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, row.d1_database_id);
}

interface ChannelInfo {
  channelId: string;
  tenantId: number | null;
  d1DatabaseId: string | null;
}

async function findChannelByXUserId(db: D1Database, xUserId: string): Promise<ChannelInfo | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.tenant_id, t.d1_database_id FROM channels c
       LEFT JOIN tenants t ON t.tenant_id = c.tenant_id
       WHERE c.channel_type IN ('TWITTER', 'X') AND c.source_channel_id = ? AND c.is_active = 1`
    )
    .bind(xUserId)
    .first<{ id: string; tenant_id: number | null; d1_database_id: string | null }>();
  if (!row) return null;
  return { channelId: row.id, tenantId: row.tenant_id, d1DatabaseId: row.d1_database_id };
}

async function handleTokenRefresh(env: Env): Promise<void> {
  const tokenService = new XTokenService(env.DB, env.X_CLIENT_ID, env.X_CLIENT_SECRET);
  const channels = await tokenService.getAllTwitterChannels();

  for (const channel of channels) {
    const { config } = channel;

    // Refresh if expiring within 30 minutes or no expires_at stored
    const shouldRefresh = !config.expires_at ||
      Date.now() > new Date(config.expires_at).getTime() - 30 * 60 * 1000;

    if (!shouldRefresh) continue;

    try {
      const newToken = await tokenService.refreshAccessToken(channel.id);
      console.log(JSON.stringify({ event: "token_refreshed", channel_id: channel.id, x_username: config.x_username }));

      // After refresh, ensure XAA subscriptions are registered
      if (!config.subscription_ids?.length) {
        try {
          const webhookUrl = `https://link-social-dev.uni-scrm.com/x/webhook`;
          // Webhook uses Bearer, subscriptions use user token
          const bearerService = new XActivityService(env.TWITTER_BEARER_TOKEN);
          let webhook = await bearerService.getWebhook();
          if (!webhook || webhook.url !== webhookUrl) {
            const whId = await bearerService.createWebhook(webhookUrl);
            webhook = { webhook_id: whId, url: webhookUrl };
          }
          const userService = new XActivityService(newToken);
          const ids = await userService.setupAllSubscriptions(config.x_user_id, webhookUrl, webhook.webhook_id);
          await tokenService.updateConfig(channel.id, { subscription_ids: ids });
          console.log(JSON.stringify({ event: "xaa_all_subscriptions_registered", channel_id: channel.id, count: ids.length }));
        } catch (e) {
          console.error("XAA subscription setup failed:", e);
        }
      }
    } catch (e) {
      console.error(`Token refresh failed for channel ${channel.id}:`, e);
    }
  }

  // TikTok token refresh
  const tiktokChannels = await env.DB
    .prepare(`SELECT id, config FROM channels WHERE channel_type = 'TIKTOK' AND is_active = 1`)
    .all<{ id: string; config: string }>();

  for (const row of tiktokChannels.results) {
    const config = JSON.parse(row.config) as { refresh_token?: string; expires_at?: string; open_id?: string; display_name?: string; avatar_url?: string; access_token?: string };
    if (!config.refresh_token) continue;

    const shouldRefresh = !config.expires_at ||
      Date.now() > new Date(config.expires_at).getTime() - 30 * 60 * 1000;
    if (!shouldRefresh) continue;

    try {
      const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY,
          client_secret: env.TIKTOK_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: config.refresh_token,
        }),
      });

      if (!res.ok) {
        console.error(`TikTok token refresh failed for ${row.id}: ${await res.text()}`);
        continue;
      }

      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
      config.access_token = data.access_token;
      if (data.refresh_token) config.refresh_token = data.refresh_token;
      if (data.expires_in) config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();

      await env.DB
        .prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(JSON.stringify(config), row.id)
        .run();

      console.log(JSON.stringify({ event: "tiktok_token_refreshed", channel_id: row.id }));
    } catch (e) {
      console.error(`TikTok token refresh error for ${row.id}:`, e);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        const result = await handleCron(env);
        return Response.json({ status: "ok", ...result });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ status: "error", message: msg }, { status: 500 });
      }
    }

    // X Activity API: CRC challenge
    if (url.pathname === "/x/webhook" && request.method === "GET") {
      const crcToken = url.searchParams.get("crc_token");
      if (!crcToken) return Response.json({ error: "Missing crc_token" }, { status: 400 });
      const webhookService = new XWebhookService(env.X_CONSUMER_SECRET);
      const responseToken = await webhookService.computeCrcResponse(crcToken);
      return Response.json({ response_token: responseToken });
    }

    // X Activity API: incoming events
    if (url.pathname === "/x/webhook" && request.method === "POST") {
      try {
        const body = await request.json() as Record<string, unknown>;
        await handleXActivityEvent(body, env);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ status: "error", message: msg }, { status: 500 });
      }
    }


    // Auth: proxy /api/auth/me to web worker
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const webUrl = env.WEB_URL || "https://web-dev.uni-scrm.com";
      return fetch(`${webUrl}/api/auth/me`, {
        headers: { Cookie: request.headers.get("Cookie") || "" },
      });
    }

    // Channel API: X status (no auth needed)
    if (url.pathname === "/api/channels/x/status" && request.method === "GET") {
      const row = await env.DB
        .prepare(`SELECT id, config FROM channels WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1 LIMIT 1`)
        .first<{ id: string; config: string }>();

      if (!row) return Response.json({ connected: false });

      const config = JSON.parse(row.config) as { x_username?: string };
      return Response.json({ connected: true, username: config.x_username, channel_id: row.id });
    }

    // Channel API: Disconnect X
    if (url.pathname === "/api/channels/x" && request.method === "DELETE") {
      await env.DB
        .prepare(`UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1`)
        .run();

      return Response.json({ ok: true });
    }

    // Channel: Connect X — OAuth 2.0 PKCE flow
    if (url.pathname === "/channel/x/connect" && request.method === "GET") {
      // Read tenant_id + member_id from session
      const sessionId = getCookieValue(request, "session");
      let tenantId: string | null = null;
      let memberId: string | null = null;
      if (sessionId) {
        const sessionData = await env.TREND_KV.get(`session:${sessionId}`);
        if (sessionData) {
          const session = JSON.parse(sessionData) as { tenant_id?: string; member_id?: string };
          tenantId = session.tenant_id || null;
          memberId = session.member_id || null;
        }
      }

      const twitter = new Twitter(env.X_CLIENT_ID, env.X_CLIENT_SECRET, `${url.origin}/channel/x/callback`);
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const arcticUrl = twitter.createAuthorizationURL(state, codeVerifier, [
        "tweet.read", "tweet.write", "users.read", "follows.read", "follows.write", "dm.read", "offline.access",
      ]);
      const oauthUrl = new URL(arcticUrl.toString().replace("https://twitter.com/", "https://x.com/"));

      // Store state + verifier + tenant_id + member_id in KV (5 min TTL)
      await env.TREND_KV.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier, tenantId, memberId }), { expirationTtl: 300 });

      return Response.redirect(oauthUrl.toString(), 302);
    }

    // Channel: X OAuth callback
    if (url.pathname === "/channel/x/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return Response.json({ error: "Missing code or state" }, { status: 400 });

      const stored = await env.TREND_KV.get(`oauth_state:${state}`);
      if (!stored) return Response.json({ error: "Invalid or expired state" }, { status: 400 });
      await env.TREND_KV.delete(`oauth_state:${state}`);
      const { codeVerifier, tenantId, memberId } = JSON.parse(stored) as { codeVerifier: string; tenantId?: string; memberId?: string };

      const twitter = new Twitter(env.X_CLIENT_ID, env.X_CLIENT_SECRET, `${url.origin}/channel/x/callback`);
      const tokens = await twitter.validateAuthorizationCode(code, codeVerifier);

      // Get user info
      const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      });
      const userData = await userRes.json() as { data: { id: string; name: string; username: string } };
      const xUser = userData.data;

      // Store tokens
      let expiresAt: string;
      try {
        expiresAt = new Date(Date.now() + tokens.accessTokenExpiresInSeconds() * 1000).toISOString();
      } catch {
        expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
      }

      const config = JSON.stringify({
        x_user_id: xUser.id,
        x_username: xUser.username,
        x_name: xUser.name,
        access_token: tokens.accessToken(),
        refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
        expires_at: expiresAt,
      });

      const channelId = crypto.randomUUID();
      await env.DB
        .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
           VALUES (?, 'X', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`)
        .bind(channelId, config, xUser.id, tokens.accessToken(), tenantId || null, memberId || null)
        .run();

      // Get actual channel ID after upsert
      const row = await env.DB
        .prepare(`SELECT id FROM channels WHERE channel_type IN ('X', 'TWITTER') AND source_channel_id = ? AND is_active = 1`)
        .bind(xUser.id)
        .first<{ id: string }>();
      const actualChannelId = row?.id || channelId;

      // Register all XAA subscriptions
      const tokenService = new XTokenService(env.DB, env.X_CLIENT_ID, env.X_CLIENT_SECRET);
      // Webhook management needs Bearer Token; subscription creation needs user token for private events
      try {
        const webhookUrl = `${url.origin}/x/webhook`;

        // Ensure webhook exists (Bearer Token)
        const bearerService = new XActivityService(env.TWITTER_BEARER_TOKEN);
        let webhook = await bearerService.getWebhook();
        if (!webhook || webhook.url !== webhookUrl) {
          const whId = await bearerService.createWebhook(webhookUrl);
          webhook = { webhook_id: whId, url: webhookUrl };
        }

        // Create subscriptions with user token + pass webhook_id
        const userService = new XActivityService(tokens.accessToken());
        const ids = await userService.setupAllSubscriptions(xUser.id, webhookUrl, webhook.webhook_id);
        await tokenService.updateConfig(actualChannelId, { subscription_ids: ids });
        console.log(JSON.stringify({ event: "xaa_all_subscriptions_created", count: ids.length }));
      } catch (e) {
        console.error("XAA subscription setup failed:", e);
      }

      return Response.redirect(url.origin, 302);
    }

    // TikTok Channel: status
    if (url.pathname === "/api/channels/tiktok/status" && request.method === "GET") {
      const row = await env.DB
        .prepare(`SELECT id, config FROM channels WHERE channel_type = 'TIKTOK' AND is_active = 1 LIMIT 1`)
        .first<{ id: string; config: string }>();

      if (!row) return Response.json({ connected: false });
      const config = JSON.parse(row.config) as { display_name?: string };
      return Response.json({ connected: true, displayName: config.display_name, channel_id: row.id });
    }

    // TikTok Channel: disconnect
    if (url.pathname === "/api/channels/tiktok" && request.method === "DELETE") {
      await env.DB.prepare(`UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE channel_type = 'TIKTOK' AND is_active = 1`).run();
      return Response.json({ ok: true });
    }

    // TikTok Channel: OAuth connect
    if (url.pathname === "/channel/tiktok/connect" && request.method === "GET") {
      const sessionId = getCookieValue(request, "session");
      let tenantId: string | null = null;
      let memberId: string | null = null;
      if (sessionId) {
        const sessionData = await env.TREND_KV.get(`session:${sessionId}`);
        if (sessionData) {
          const session = JSON.parse(sessionData) as { tenant_id?: string; member_id?: string };
          tenantId = session.tenant_id || null;
          memberId = session.member_id || null;
        }
      }

      const state = crypto.randomUUID();
      await env.TREND_KV.put(`oauth_state:${state}`, JSON.stringify({ tenantId, memberId, provider: "tiktok" }), { expirationTtl: 300 });

      const redirectUri = encodeURIComponent(`${url.origin}/channel/tiktok/callback`);
      const tiktokUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.list&response_type=code&redirect_uri=${redirectUri}&state=${state}`;

      return Response.redirect(tiktokUrl, 302);
    }

    // TikTok Channel: OAuth callback
    if (url.pathname === "/channel/tiktok/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return Response.json({ error: "Missing code or state" }, { status: 400 });

      const stored = await env.TREND_KV.get(`oauth_state:${state}`);
      if (!stored) return Response.json({ error: "Invalid or expired state" }, { status: 400 });
      await env.TREND_KV.delete(`oauth_state:${state}`);
      const { tenantId, memberId } = JSON.parse(stored) as { tenantId?: string; memberId?: string };

      // Exchange code for token
      const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY,
          client_secret: env.TIKTOK_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: `${url.origin}/channel/tiktok/callback`,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return Response.json({ error: `Token exchange failed: ${err}` }, { status: 400 });
      }

      const tokenData = (await tokenRes.json()) as {
        open_id: string;
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      // Fetch user info
      const userRes = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = (await userRes.json()) as { data?: { user?: { open_id: string; display_name: string; avatar_url?: string } } };
      const tiktokUser = userData.data?.user;

      const openId = tiktokUser?.open_id || tokenData.open_id;
      const displayName = tiktokUser?.display_name || "";
      const avatarUrl = tiktokUser?.avatar_url || "";

      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : new Date(Date.now() + 86400 * 1000).toISOString();

      const config = JSON.stringify({
        open_id: openId,
        display_name: displayName,
        avatar_url: avatarUrl,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        expires_at: expiresAt,
      });

      const channelId = crypto.randomUUID();
      await env.DB
        .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
           VALUES (?, 'TIKTOK', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`)
        .bind(channelId, config, openId, tokenData.access_token, tenantId ? parseInt(tenantId) : null, memberId || null)
        .run();

      // Trigger link-content to sync TikTok videos
      try {
        const contentUrl = env.WEB_URL.replace("web-dev", "content-dev").replace("web.", "content.");
        await fetch(`${contentUrl}/api/internal/tiktok/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("TikTok content sync trigger failed:", e);
      }

      return Response.redirect(url.origin, 302);
    }

    // Users API: paginated list
    if (url.pathname === "/api/users" && request.method === "GET") {
      const tdb = await resolveTenantDataDb(request, env);
      if (!tdb) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
      const offset = (page - 1) * limit;

      const countRows = await tdb.query<{ total: number }>(`SELECT COUNT(*) as total FROM user`);
      const total = countRows[0]?.total || 0;

      const rows = await tdb.query<{ id: string; name: string; username: string; profile_image_url: string; updated_at: string }>(
        `SELECT id, name, username, profile_image_url, updated_at FROM user ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      return Response.json({ users: rows, total, page, totalPages: Math.ceil(total / limit) });
    }

    // Users API: single user detail
    if (url.pathname.match(/^\/api\/users\/[^/]+$/) && request.method === "GET") {
      const tdb = await resolveTenantDataDb(request, env);
      if (!tdb) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const userId = url.pathname.split("/").pop()!;
      const rows = await tdb.query(
        `SELECT id, name, username, profile_image_url, socials, maigret_status, raw_data, created_at, updated_at FROM user WHERE id = ?`,
        [userId]
      );

      if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ user: rows[0] });
    }

    // Users API: user events with offset pagination
    if (url.pathname.match(/^\/api\/users\/[^/]+\/events$/) && request.method === "GET") {
      const tdb = await resolveTenantDataDb(request, env);
      if (!tdb) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const userId = url.pathname.split("/")[3];
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));

      const rows = await tdb.query<{ id: string; event_type: string; event_time: string; raw_data: string; created_at: string }>(
        `SELECT id, event_type, event_time, raw_data, created_at FROM event WHERE user_id = ? ORDER BY event_time DESC LIMIT ? OFFSET ?`,
        [userId, limit + 1, offset]
      );

      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;

      return Response.json({ events, hasMore });
    }

    // Maigret: batch retry pending/failed users
    if (url.pathname === "/x/maigret-retry" && request.method === "POST") {
      const secret = request.headers.get("X-Internal-Secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const tenantDbId = url.searchParams.get("db_id");
      if (!tenantDbId) return Response.json({ error: "db_id required" }, { status: 400 });

      const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantDbId);
      const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
      const rows = await tdb.query<{ id: string; username: string }>(
        `SELECT id, username FROM user WHERE maigret_status IN ('pending', 'failed') AND username IS NOT NULL LIMIT ?`,
        [limit]
      );

      if (rows.length > 0) {
        const messages = rows.map((r) => ({ body: { user_id: r.id, username: r.username, db_id: tenantDbId } }));
        await env.MAIGRET_QUEUE.sendBatch(messages);

        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        await tdb.run(
          `UPDATE user SET maigret_status = 'running' WHERE id IN (${placeholders})`,
          ids
        );
      }

      return Response.json({ queued: rows.length });
    }

    // Users API: write maigret socials results (internal)
    if (url.pathname.match(/^\/api\/users\/[^/]+\/socials$/) && request.method === "POST") {
      const secret = request.headers.get("X-Internal-Secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const userId = url.pathname.split("/")[3];
      const { socials, status, db_id } = await request.json() as { socials: Record<string, string>; status: string; db_id: string };
      if (!db_id) return Response.json({ error: "db_id required" }, { status: 400 });

      const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, db_id);
      await tdb.run(
        `UPDATE user SET socials = ?, maigret_status = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify(socials), status, userId]
      );

      return Response.json({ ok: true });
    }

    // Internal: X follow/unfollow action
    if (url.pathname === "/internal/x/action" && request.method === "POST") {
      const secret = request.headers.get("X-Internal-Secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const { channelId, targetUserId, action } = await request.json() as {
        channelId: string; targetUserId: string; action: "follow" | "unfollow";
      };
      if (!channelId || !targetUserId || !action) {
        return Response.json({ error: "channelId, targetUserId, action required" }, { status: 400 });
      }

      const channel = await env.DB.prepare(`SELECT config FROM channels WHERE id = ?`)
        .bind(channelId).first<{ config: string }>();
      if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });

      const config = JSON.parse(channel.config);
      const sourceUserId = config.x_user_id;
      if (!sourceUserId) return Response.json({ error: "Channel has no X user ID" }, { status: 400 });

      const tokenService = new XTokenService(env.DB, env.X_CLIENT_ID, env.X_CLIENT_SECRET);
      const accessToken = await tokenService.getValidToken(channelId);

      let xRes: Response;
      if (action === "follow") {
        xRes = await fetch(`https://api.x.com/2/users/${sourceUserId}/following`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ target_user_id: targetUserId }),
        });
      } else {
        xRes = await fetch(`https://api.x.com/2/users/${sourceUserId}/following/${targetUserId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      }

      const xBody = await xRes.json();
      const rateLimitRemaining = parseInt(xRes.headers.get("x-rate-limit-remaining") || "-1", 10);
      const rateLimitResetUnix = parseInt(xRes.headers.get("x-rate-limit-reset") || "0", 10);
      const rateLimitReset = rateLimitResetUnix ? new Date(rateLimitResetUnix * 1000).toISOString() : "";

      console.log(JSON.stringify({ event: "x_action_executed", action, sourceUserId, targetUserId, status: xRes.status, rateLimitRemaining, rateLimitReset }));

      return Response.json({
        ok: xRes.ok,
        status: xRes.status,
        rateLimited: xRes.status === 429,
        rateLimitRemaining,
        rateLimitReset,
        data: xBody,
      });
    }

    // Auth check for page requests — redirect to login if no session
    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html")) {
      const sessionCookie = getCookieValue(request, "session");
      if (!sessionCookie) {
        const webUrl = env.WEB_URL || "https://web-dev.uni-scrm.com";
        return Response.redirect(`${webUrl}/login`, 302);
      }
    }

    // SPA fallback
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
      }
      return res;
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
    ctx.waitUntil(handleTokenRefresh(env));
  },
};
