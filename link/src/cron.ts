import type { Env } from "./types";
import type { TrendSource } from "./trend/sources/interface";
import { getTwitterConfig, getTikTokConfig, getDouyinConfig } from "./trend/config";
import { TwitterTrendSource } from "./trend/sources/twitter";
import { TikTokTrendSource } from "./trend/sources/tiktok";
import { DouyinTrendSource } from "./trend/sources/douyin";
import { Aggregator } from "./trend/aggregator";
import { TrendCache } from "./trend/storage/cache";
import { TrendVectorStore } from "./trend/storage/vectorize";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";
import { runFollowersPoller } from "./services/pollers/x-followers";
import { runPostsPoller } from "./services/pollers/x-posts";
import { XUnauthorizedError } from "./services/x-errors";
import { TenantDataDB } from "../../shared/tenant-data-db";

export async function handleCron(env: Env): Promise<void> {
  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
    handlePolling(env),
  ]);
}

async function handleTrendAggregation(env: Env): Promise<void> {
  const sources: TrendSource[] = [];

  const twitterConfig = getTwitterConfig();
  if (twitterConfig && env.X_BEARER_TOKEN) {
    sources.push(new TwitterTrendSource(env.X_BEARER_TOKEN));
  }

  const tiktokConfig = getTikTokConfig();
  if (tiktokConfig && env.FIRECRAWL_API_KEY && env.TIKTOK_COOKIE) {
    sources.push(new TikTokTrendSource(env.FIRECRAWL_API_KEY, env.TIKTOK_COOKIE, tiktokConfig.locations, tiktokConfig.categories));
  }

  const douyinConfig = getDouyinConfig();
  if (douyinConfig && env.FIRECRAWL_API_KEY && env.DOUYIN_COOKIE) {
    sources.push(new DouyinTrendSource(env.FIRECRAWL_API_KEY, env.DOUYIN_COOKIE, douyinConfig.categories));
  }

  if (sources.length === 0) return;

  const aggregator = new Aggregator(sources);
  const cache = new TrendCache(env.KV);
  const vectorStore = new TrendVectorStore(env.VECTORIZE, env.AI);

  const { items, failedPlatforms } = await aggregator.fetchAll();

  if (failedPlatforms.length > 0) {
    console.log(JSON.stringify({ event: "link.fetch_partial_failure", failedPlatforms, successCount: items.length }));
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

  console.log(JSON.stringify({ event: "link.cron_complete", totalItems: items.length, platforms: [...new Set(items.map((i) => i.platform))] }));
}

async function handleTokenRefresh(env: Env): Promise<void> {
  // X token refresh (system app + BYOK)
  const rows = await env.LINK_DB
    .prepare("SELECT id, config FROM channels WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1")
    .all<{ id: string; config: string }>();

  for (const row of rows.results) {
    const config = JSON.parse(row.config) as ByokConfig & {
      access_token?: string; refresh_token?: string; expires_at?: string;
      x_user_id?: string; x_username?: string; subscription_ids?: string[];
    };
    if (!config.refresh_token) continue;

    const shouldRefresh = !config.expires_at ||
      Date.now() > new Date(config.expires_at).getTime() - 30 * 60 * 1000;
    if (!shouldRefresh) continue;

    try {
      const creds = await getAppCredentials(env, config);
      const tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
      const newToken = await tokenService.refreshAccessToken(row.id);
      console.log(JSON.stringify({ event: "token_refreshed", channel_id: row.id, x_username: config.x_username, is_byok: !!config.is_byok }));

      if (!config.subscription_ids?.length && config.x_user_id) {
        try {
          if (config.is_byok) {
            const webhookUrl = `${env.LINK_URL}/x/webhook/${row.id}`;
            const userService = new XActivityService(newToken);
            const ids = await userService.setupAllSubscriptions(config.x_user_id, webhookUrl);
            await tokenService.updateConfig(row.id, { subscription_ids: ids });
          } else {
            const webhookUrl = `${env.LINK_URL}/x/webhook`;
            const bearerService = new XActivityService(env.X_BEARER_TOKEN);
            let webhook = await bearerService.getWebhook();
            if (!webhook || webhook.url !== webhookUrl) {
              const whId = await bearerService.createWebhook(webhookUrl);
              webhook = { webhook_id: whId, url: webhookUrl };
            }
            const userService = new XActivityService(newToken);
            const ids = await userService.setupAllSubscriptions(config.x_user_id, webhookUrl, webhook.webhook_id);
            await tokenService.updateConfig(row.id, { subscription_ids: ids });
          }
        } catch (e) {
          console.error("XAA subscription setup failed:", e);
        }
      }
    } catch (e) {
      console.error(`Token refresh failed for channel ${row.id}:`, e);
    }
  }

  // TikTok token refresh
  const tiktokChannels = await env.LINK_DB
    .prepare("SELECT id, config FROM channels WHERE channel_type = 'TIKTOK' AND is_active = 1")
    .all<{ id: string; config: string }>();

  for (const row of tiktokChannels.results) {
    const config = JSON.parse(row.config) as { refresh_token?: string; expires_at?: string; access_token?: string };
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

      await env.LINK_DB.prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(config), row.id)
        .run();

      console.log(JSON.stringify({ event: "tiktok_token_refreshed", channel_id: row.id }));
    } catch (e) {
      console.error(`TikTok token refresh error for ${row.id}:`, e);
    }
  }
}

export async function handlePolling(env: Env): Promise<void> {
  const PER_CHANNEL_BUDGET_MS = 20_000;
  const TOTAL_BUDGET_MS = 50_000;
  const REPOLL_INTERVAL_MS = 55 * 60 * 1000; // just under an hour, guards overlapping cron runs
  const runDeadline = Date.now() + TOTAL_BUDGET_MS;

  const rows = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = 'X' AND is_active = 1")
    .all<{ id: string; config: string; tenant_id: number | null }>();

  console.log(JSON.stringify({ event: "polling_cron_started", candidateChannels: rows.results.length }));

  for (const row of rows.results) {
    if (Date.now() >= runDeadline) {
      console.log(JSON.stringify({ event: "polling_cron_budget_exhausted", channel_id: row.id }));
      break;
    }

    const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
    if (!config.is_byok) continue;
    if (!config.x_user_id || !row.tenant_id) {
      console.log(JSON.stringify({ event: "followers_poll_skipped_unauthorized", channel_id: row.id, hasXUserId: !!config.x_user_id, hasTenantId: !!row.tenant_id }));
      continue;
    }

    const shouldPoll = async (pollerName: "followers" | "posts"): Promise<boolean> => {
      const state = await env.LINK_DB
        .prepare("SELECT backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
        .bind(row.id, pollerName)
        .first<{ backfill_complete: number; last_polled_at: string | null }>();
      if (!state) {
        console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_no_state_row`, channel_id: row.id }));
        return false;
      }
      if (state.backfill_complete && state.last_polled_at) {
        const elapsedMs = Date.now() - new Date(state.last_polled_at).getTime();
        if (elapsedMs < REPOLL_INTERVAL_MS) {
          console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_too_recent`, channel_id: row.id, elapsedMs }));
          return false;
        }
      }
      return true;
    };

    const pollFollowers = await shouldPoll("followers");
    const pollPosts = await shouldPoll("posts");
    if (!pollFollowers && !pollPosts) continue;

    let accessToken: string;
    let tenantDb: TenantDataDB;
    let tokenService: XTokenService;
    try {
      const creds = await getAppCredentials(env, config);
      tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
      accessToken = await tokenService.getValidToken(row.id);

      const tenant = await env.WEB_DB
        .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(row.tenant_id)
        .first<{ d1_database_id: string | null }>();
      if (!tenant?.d1_database_id) continue;

      tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
    } catch (e) {
      console.error(JSON.stringify({ event: "poll_setup_error", channel_id: row.id, error: String(e) }));
      continue;
    }

    // Each poller gets its own try/catch: a failure in one (e.g. a transient X API
    // error) must not prevent the other from running for the same channel/tick.
    //
    // A 401 mid-poll means the access token was rejected even though getValidToken
    // thought it was still fresh (early revocation, clock skew, concurrent refresh
    // elsewhere). Force one refresh (which persists the new token to channels.config
    // via XTokenService.refreshAccessToken) and retry the poller once before giving up.
    if (pollFollowers) {
      try {
        try {
          await runFollowersPoller({
            channelId: row.id,
            xUserId: config.x_user_id,
            accessToken,
            linkDb: env.LINK_DB,
            tenantDb,
            tenantId: row.tenant_id,
            pipelineUser: env.PIPELINE_USER,
            deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
          });
        } catch (e) {
          if (!(e instanceof XUnauthorizedError)) throw e;
          console.log(JSON.stringify({ event: "followers_poll_token_refresh_retry", channel_id: row.id }));
          accessToken = await tokenService.refreshAccessToken(row.id);
          await runFollowersPoller({
            channelId: row.id,
            xUserId: config.x_user_id,
            accessToken,
            linkDb: env.LINK_DB,
            tenantDb,
            tenantId: row.tenant_id,
            pipelineUser: env.PIPELINE_USER,
            deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
          });
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "followers_poll_error", channel_id: row.id, error: String(e) }));
      }
    }

    if (pollPosts) {
      try {
        try {
          await runPostsPoller({
            channelId: row.id,
            xUserId: config.x_user_id,
            accessToken,
            linkDb: env.LINK_DB,
            tenantDb,
            tenantId: row.tenant_id,
            ai: env.AI,
            vectorize: env.VECTORIZE,
            deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
          });
        } catch (e) {
          if (!(e instanceof XUnauthorizedError)) throw e;
          console.log(JSON.stringify({ event: "posts_poll_token_refresh_retry", channel_id: row.id }));
          accessToken = await tokenService.refreshAccessToken(row.id);
          await runPostsPoller({
            channelId: row.id,
            xUserId: config.x_user_id,
            accessToken,
            linkDb: env.LINK_DB,
            tenantDb,
            tenantId: row.tenant_id,
            ai: env.AI,
            vectorize: env.VECTORIZE,
            deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
          });
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "posts_poll_error", channel_id: row.id, error: String(e) }));
      }
    }
  }
}
