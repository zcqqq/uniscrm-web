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
import { XWebhookService, XActivityService } from "./services/x-webhook";
import { XTokenService } from "./services/x-token";
import { Twitter, generateState, generateCodeVerifier } from "arctic";

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
  const usersService = new XUsersService(env.DB, env.MAIGRET_QUEUE);

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

  const channelId = await findChannelIdByXUserId(env.DB, filterUserId);
  if (!channelId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_channel", filterUserId }));
    return;
  }

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
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: eventType === "follow.follow" ? "follow.follow" : "follow.unfollow",
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);
      console.log(JSON.stringify({ event: "xaa_event_processed", eventType: "follow.follow", userId: userData.id }));
    } else if (targetId === filterUserId && source?.data) {
      // Someone followed/unfollowed the channel → record the source user
      const userData = source.data;
      await usersService.upsertUser({
        id: userData.id as string,
        name: userData.name as string | undefined,
        username: userData.username as string | undefined,
        profile_image_url: userData.profile_image_url as string | undefined,
      });
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: eventType === "follow.follow" ? "follow.followed" : "follow.unfollowed",
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);
      console.log(JSON.stringify({ event: "xaa_event_processed", eventType: "follow.followed", userId: userData.id }));
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

async function findChannelIdByXUserId(db: D1Database, xUserId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM channels WHERE channel_type IN ('TWITTER', 'X') AND external_channel_id = ?`)
    .bind(xUserId)
    .first<{ id: string }>();
  return row?.id || null;
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

    // Channel API: Twitter status (no auth needed)
    if (url.pathname === "/api/channels/twitter/status" && request.method === "GET") {
      const row = await env.DB
        .prepare(`SELECT id, config FROM channels WHERE channel_type IN ('TWITTER', 'X') LIMIT 1`)
        .first<{ id: string; config: string }>();

      if (!row) return Response.json({ connected: false });

      const config = JSON.parse(row.config) as { x_username?: string };
      return Response.json({ connected: true, username: config.x_username, channel_id: row.id });
    }

    // Channel API: Disconnect Twitter
    if (url.pathname === "/api/channels/twitter" && request.method === "DELETE") {
      await env.DB
        .prepare(`DELETE FROM channels WHERE channel_type IN ('TWITTER', 'X')`)
        .run();

      return Response.json({ ok: true });
    }

    // Channel: Connect Twitter — OAuth 2.0 PKCE flow
    if (url.pathname === "/channel/twitter/connect" && request.method === "GET") {
      const twitter = new Twitter(env.X_CLIENT_ID, env.X_CLIENT_SECRET, `${url.origin}/channel/twitter/callback`);
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const arcticUrl = twitter.createAuthorizationURL(state, codeVerifier, [
        "tweet.read", "tweet.write", "users.read", "follows.read", "follows.write", "dm.read", "offline.access",
      ]);
      const oauthUrl = new URL(arcticUrl.toString().replace("https://twitter.com/", "https://x.com/"));

      // Store state + verifier in KV (5 min TTL)
      await env.TREND_KV.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier }), { expirationTtl: 300 });

      return Response.redirect(oauthUrl.toString(), 302);
    }

    // Channel: Twitter OAuth callback
    if (url.pathname === "/channel/twitter/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return Response.json({ error: "Missing code or state" }, { status: 400 });

      const stored = await env.TREND_KV.get(`oauth_state:${state}`);
      if (!stored) return Response.json({ error: "Invalid or expired state" }, { status: 400 });
      await env.TREND_KV.delete(`oauth_state:${state}`);
      const { codeVerifier } = JSON.parse(stored) as { codeVerifier: string };

      const twitter = new Twitter(env.X_CLIENT_ID, env.X_CLIENT_SECRET, `${url.origin}/channel/twitter/callback`);
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
        .prepare(`INSERT INTO channels (id, user_id, channel_type, config, external_channel_id, created_at, updated_at)
           VALUES (?, 'system', 'X', ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(user_id, channel_type) DO UPDATE SET config = excluded.config, external_channel_id = excluded.external_channel_id, updated_at = datetime('now')`)
        .bind(channelId, config, xUser.id)
        .run();

      // Get actual channel ID after upsert
      const row = await env.DB
        .prepare(`SELECT id FROM channels WHERE channel_type IN ('X', 'TWITTER') AND external_channel_id = ?`)
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

    // Users API: paginated list
    if (url.pathname === "/api/users" && request.method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
      const offset = (page - 1) * limit;

      const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM user_x`).first<{ total: number }>();
      const total = countRow?.total || 0;

      const rows = await env.DB
        .prepare(`SELECT id, name, username, profile_image_url, updated_at FROM user_x ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .bind(limit, offset)
        .all<{ id: string; name: string; username: string; profile_image_url: string; updated_at: string }>();

      return Response.json({
        users: rows.results,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    }

    // Users API: single user detail
    if (url.pathname.match(/^\/api\/users\/[^/]+$/) && request.method === "GET") {
      const userId = url.pathname.split("/").pop()!;
      const user = await env.DB
        .prepare(`SELECT id, name, username, profile_image_url, socials, maigret_status, raw_data, created_at, updated_at FROM user_x WHERE id = ?`)
        .bind(userId)
        .first();

      if (!user) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ user });
    }

    // Users API: user events with offset pagination
    if (url.pathname.match(/^\/api\/users\/[^/]+\/events$/) && request.method === "GET") {
      const userId = url.pathname.split("/")[3];
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));

      const rows = await env.DB
        .prepare(`SELECT id, event_type, event_time, raw_data, created_at FROM event_x WHERE user_id = ? ORDER BY event_time DESC LIMIT ? OFFSET ?`)
        .bind(userId, limit + 1, offset)
        .all<{ id: string; event_type: string; event_time: string; raw_data: string; created_at: string }>();

      const hasMore = rows.results.length > limit;
      const events = hasMore ? rows.results.slice(0, limit) : rows.results;

      return Response.json({ events, hasMore });
    }

    // Maigret: batch retry pending/failed users
    if (url.pathname === "/x/maigret-retry" && request.method === "POST") {
      const secret = request.headers.get("X-Internal-Secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
      const rows = await env.DB
        .prepare(`SELECT id, username FROM user_x WHERE maigret_status IN ('pending', 'failed') AND username IS NOT NULL LIMIT ?`)
        .bind(limit)
        .all<{ id: string; username: string }>();

      if (rows.results.length > 0) {
        const messages = rows.results.map((r) => ({ body: { user_id: r.id, username: r.username } }));
        await env.MAIGRET_QUEUE.sendBatch(messages);

        const ids = rows.results.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        await env.DB
          .prepare(`UPDATE user_x SET maigret_status = 'running' WHERE id IN (${placeholders})`)
          .bind(...ids)
          .run();
      }

      return Response.json({ queued: rows.results.length });
    }

    // Users API: write maigret socials results (internal)
    if (url.pathname.match(/^\/api\/users\/[^/]+\/socials$/) && request.method === "POST") {
      const secret = request.headers.get("X-Internal-Secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const userId = url.pathname.split("/")[3];
      const { socials, status } = await request.json() as { socials: Record<string, string>; status: string };

      await env.DB
        .prepare(`UPDATE user_x SET socials = ?, maigret_status = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(JSON.stringify(socials), status, userId)
        .run();

      return Response.json({ ok: true });
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
