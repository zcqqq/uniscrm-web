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
import { TikTokTokenService } from "./services/tiktok-token";
import { pollChannelOnce, pollXListPosts } from "./services/pollers/poll-channel";

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

  const tiktokTokenService = new TikTokTokenService(env.LINK_DB, env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET);

  for (const row of tiktokChannels.results) {
    const config = JSON.parse(row.config) as { refresh_token?: string; expires_at?: string };
    if (!config.refresh_token) continue;

    const shouldRefresh = !config.expires_at ||
      Date.now() > new Date(config.expires_at).getTime() - 30 * 60 * 1000;
    if (!shouldRefresh) continue;

    try {
      await tiktokTokenService.refreshAccessToken(row.id);
      console.log(JSON.stringify({ event: "tiktok_token_refreshed", channel_id: row.id }));
    } catch (e) {
      console.error(`TikTok token refresh error for ${row.id}:`, e);
    }
  }
}

export async function handlePolling(env: Env): Promise<void> {
  const TOTAL_BUDGET_MS = 50_000;
  const runDeadline = Date.now() + TOTAL_BUDGET_MS;

  const rows = await env.LINK_DB
    .prepare("SELECT id, channel_type FROM channels WHERE channel_type IN ('X', 'TIKTOK') AND is_active = 1")
    .all<{ id: string; channel_type: "X" | "TIKTOK" }>();

  console.log(JSON.stringify({ event: "polling_cron_started", candidateChannels: rows.results.length }));

  for (const row of rows.results) {
    if (Date.now() >= runDeadline) {
      console.log(JSON.stringify({ event: "polling_cron_budget_exhausted", channel_id: row.id }));
      break;
    }
    await pollChannelOnce(env, row.channel_type, row.id);
  }

  if (Date.now() < runDeadline) {
    try {
      const res = await fetch(`${env.FLOW_URL}/internal/list-watches`, {
        headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
      });
      if (res.ok) {
        const { watches } = await res.json() as { watches: { channelId: string; listId: string }[] };
        console.log(JSON.stringify({ event: "list_watches_fetched", count: watches.length }));
        for (const w of watches) {
          if (Date.now() >= runDeadline) {
            console.log(JSON.stringify({ event: "polling_cron_budget_exhausted", channel_id: w.channelId, list_id: w.listId }));
            break;
          }
          await pollXListPosts(env, w.channelId, w.listId);
        }
      } else {
        console.error(JSON.stringify({ event: "list_watches_fetch_failed", status: res.status }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "list_watches_fetch_error", error: String(e) }));
    }
  }
}
