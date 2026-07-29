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
import { pollChannelOnce, pollXListPosts, pollYouTubeChannel } from "./services/pollers/poll-channel";
import { subscribeWebSub } from "./services/youtube-api";
import { clearChannelFrozen } from "./services/x-freeze";

export async function handleCron(env: Env): Promise<void> {
  // The unfreeze probe runs BEFORE the rest: a channel that recovered this hour should be
  // polled and refreshed in the same tick rather than waiting another hour. Its own failure is
  // swallowed here — everything below (trends, token refresh, polling, WebSub renewal) is
  // independent of it, and Promise.allSettled would not cover a throw from this awaited call.
  await handleFrozenProbe(env).catch((e) => {
    console.error(JSON.stringify({ event: "x_freeze_probe_sweep_error", error: String(e) }));
  });

  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
    handlePolling(env),
    handleYouTubeRenewal(env),
    handleYouTubeSubscriptions(env),
  ]);
}

/**
 * One GET /2/users/me per frozen channel, per hour — the only X call a frozen channel is
 * allowed to make. A 200 means the account is back, so the breaker clears and everything
 * resumes by itself; anything else leaves it frozen. See x-freeze.ts for why the breaker
 * exists at all.
 */
export async function handleFrozenProbe(env: Env): Promise<void> {
  const rows = await env.LINK_DB
    .prepare(
      `SELECT id, config FROM channels
        WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1
          AND json_extract(config, '$.x_frozen_at') IS NOT NULL`
    )
    .all<{ id: string; config: string }>();

  for (const row of rows.results) {
    const config = JSON.parse(row.config) as ByokConfig & { access_token?: string; expires_at?: string; refresh_token?: string };
    try {
      // getValidToken refuses frozen channels by design, so the probe reads the stored token
      // directly and refreshes only when it has actually expired. Token refresh is an app-level
      // call — it does not touch the locked account's own endpoints.
      let accessToken = config.access_token;
      const expired = !config.expires_at || Date.now() > new Date(config.expires_at).getTime() - 60 * 1000;
      if (expired && config.refresh_token) {
        const creds = await getAppCredentials(env, config);
        accessToken = await new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret).refreshAccessToken(row.id);
      }
      if (!accessToken) continue;

      const res = await fetch("https://api.x.com/2/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        await clearChannelFrozen(env.LINK_DB, row.id);
        continue;
      }
      console.log(JSON.stringify({ event: "x_freeze_probe_still_frozen", channel_id: row.id, status: res.status }));
    } catch (e) {
      console.error(JSON.stringify({ event: "x_freeze_probe_error", channel_id: row.id, error: String(e) }));
    }
  }
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
    // Frozen channels are excluded: handleFrozenProbe above is the only thing allowed to call
    // X for them, and it refreshes their token itself when the probe needs one.
    .prepare("SELECT id, config FROM channels WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1 AND json_extract(config, '$.x_frozen_at') IS NULL")
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
          // Both branches: app-only Bearer registers the webhook, the freshly refreshed USER
          // token creates the subscriptions. The BYOK branch used to hand the user token to
          // both, which `/2/webhooks` rejects with 403 (see oauth.ts's BYOK branch).
          const webhookUrl = config.is_byok
            ? `${env.LINK_URL}/x/webhook/${row.id}`
            : `${env.LINK_URL}/x/webhook`;
          if (!creds.bearerToken) {
            throw new Error(`channel ${row.id} has no app-only bearer token — cannot register its webhook`);
          }
          const bearerService = new XActivityService(creds.bearerToken);
          let webhook = await bearerService.getWebhook(webhookUrl);
          if (!webhook) {
            const whId = await bearerService.createWebhook(webhookUrl);
            webhook = { webhook_id: whId, url: webhookUrl };
          }
          const userService = new XActivityService(newToken);
          const ids = await userService.setupAllSubscriptions(config.x_user_id, webhookUrl, webhook.webhook_id);
          await tokenService.updateConfig(row.id, { subscription_ids: ids });
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
    // json_extract is NULL for TikTok rows too (they never carry the key), so the freeze
    // filter narrows X channels only; it's a no-op (always true) for TikTok.
    // YOUTUBE_ACCOUNT is deliberately NOT in this list: it used to ride this same 50s-budget
    // queue and, having no ORDER BY, was appended last on every single run — so it was starved
    // every time the queue filled up on X/TikTok work (confirmed on dev: polling_cron_started
    // logged 4 candidates, polling_cron_budget_exhausted always fired on the YouTube row, and
    // channel_poll_state never gained a poller_name='subscriptions' row). It has its own
    // 23-hour self-throttle and a handful of calls per run, so it gets its own top-level
    // handler (handleYouTubeSubscriptions) instead of sharing this rationed budget.
    .prepare("SELECT id, channel_type FROM channels WHERE channel_type IN ('X', 'TIKTOK') AND is_active = 1 AND json_extract(config, '$.x_frozen_at') IS NULL")
    .all<{ id: string; channel_type: "X" | "TIKTOK" }>();

  console.log(JSON.stringify({ event: "polling_cron_started", candidateChannels: rows.results.length }));

  for (const row of rows.results) {
    if (Date.now() >= runDeadline) {
      console.log(JSON.stringify({ event: "polling_cron_budget_exhausted", channel_id: row.id }));
      break;
    }
    try {
      await pollChannelOnce(env, row.channel_type, row.id);
    } catch (e) {
      console.error(JSON.stringify({
        event: "poll_channel_error",
        channel_id: row.id,
        channel_type: row.channel_type,
        error: String(e),
      }));
    }
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

const YOUTUBE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

async function handleYouTubeRenewal(env: Env): Promise<void> {
  let watches: { channelId: string; subscriptionChannelId: string }[];
  try {
    const res = await fetch(`${env.FLOW_URL}/internal/youtube-watches`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    ({ watches } = (await res.json()) as { watches: { channelId: string; subscriptionChannelId: string }[] });
  } catch (e) {
    // Don't touch any subscription if we can't confirm what's still referenced —
    // an unsubscribe based on stale/missing data would silently kill a live trigger.
    console.error(JSON.stringify({ event: "youtube_watches_fetch_error", error: String(e) }));
    return;
  }

  for (const { channelId: accountChannelId, subscriptionChannelId: youtubeChannelId } of watches) {
    const leaseRow = await env.LINK_DB
      .prepare("SELECT lease_expires_at FROM youtube_websub_leases WHERE account_channel_id = ? AND youtube_channel_id = ?")
      .bind(accountChannelId, youtubeChannelId)
      .first<{ lease_expires_at: string | null }>();

    const expiresAt = leaseRow?.lease_expires_at ? new Date(leaseRow.lease_expires_at).getTime() : 0;
    // No lease row at all (never subscribed) or nearing expiry — (re)subscribe either way.
    if (leaseRow && expiresAt - Date.now() > YOUTUBE_RENEWAL_WINDOW_MS) continue;

    try {
      await subscribeWebSub(`${env.LINK_URL}/youtube/websub/${accountChannelId}/${youtubeChannelId}`, youtubeChannelId);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_resubscribe_error", account_channel_id: accountChannelId, subscription_channel_id: youtubeChannelId, error: String(e) }));
    }
  }
}

// YouTube 订阅同步独立成一个 handler，不再挤在 handlePolling 的 50s 预算队列里 —— 那条队列
// 服务 X/TikTok 每 55 分钟一次的重负载分页拉取，YouTube 这边是每账号每 23 小时一次、几个
// API 调用就完事、且自带节流（channel_poll_state.last_polled_at），排在队尾必然被饿死
// （dev 上已实测复现：polling_cron_budget_exhausted 每次都精确打在 YouTube 那一行）。
// 预算给得比 handlePolling 小得多：YouTube 账号数量级远小于 X/TikTok，且每次真正执行同步的
// 只是过了 23 小时节流的那一小撮；这里只是防止某个账号的走查异常拖慢，卡住同一次 cron 里
// 其它独立 handler 的调度节奏。
const YOUTUBE_SUBSCRIPTIONS_BUDGET_MS = 20_000;

export async function handleYouTubeSubscriptions(env: Env): Promise<void> {
  const deadline = Date.now() + YOUTUBE_SUBSCRIPTIONS_BUDGET_MS;

  const rows = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND is_active = 1")
    .all<{ id: string; config: string; tenant_id: number | null }>();

  console.log(JSON.stringify({ event: "youtube_subscriptions_cron_started", candidateChannels: rows.results.length }));

  for (const row of rows.results) {
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ event: "youtube_subscriptions_cron_budget_exhausted", channel_id: row.id }));
      break;
    }
    try {
      await pollYouTubeChannel(env, row);
    } catch (e) {
      // Per-iteration guard, deliberately mirroring handlePolling's loop: one account's
      // failure must not abort the loop and starve every account queued behind it — that
      // silent starvation is exactly the bug this handler exists to avoid reintroducing.
      console.error(JSON.stringify({ event: "youtube_subscriptions_channel_error", channel_id: row.id, error: String(e) }));
    }
  }
}
