import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { ensureXSubscriptions } from "./services/x-subscription-repair";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";
import { TikTokTokenService } from "./services/tiktok-token";
import { pollChannelOnce, pollXListPosts, pollYouTubeChannel } from "./services/pollers/poll-channel";
import { subscribeWebSub } from "./services/youtube-api";
import { clearChannelFrozen } from "./services/x-freeze";
import { runGitHubReleasePoller } from "./services/pollers/github-releases";
import { GitHubUnauthorizedError } from "./services/github-api";
import { ContentService } from "./services/content";
import { EntityStateStore } from "./services/entity-state";
import { resolveTenantDb } from "./services/tenant-db";

export async function handleCron(env: Env): Promise<void> {
  // The unfreeze probe runs BEFORE the rest: a channel that recovered this hour should be
  // polled and refreshed in the same tick rather than waiting another hour. Its own failure is
  // swallowed here — everything below (token refresh, polling, WebSub renewal) is
  // independent of it, and Promise.allSettled would not cover a throw from this awaited call.
  await handleFrozenProbe(env).catch((e) => {
    console.error(JSON.stringify({ event: "x_freeze_probe_sweep_error", error: String(e) }));
  });

  await Promise.allSettled([
    handleTokenRefresh(env),
    handlePolling(env),
    handleYouTubeRenewal(env),
    handleYouTubeSubscriptions(env),
    handleGitHubReleases(env),
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

// Exported for tests: the BYOK subscription-repair branch inside is the only thing that can
// give a reconnected channel its subscriptions back, and it had no coverage while it silently
// failed for two days (dev, 2026-08-07 → 08-09).
export async function handleTokenRefresh(env: Env): Promise<void> {
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
          // Shared with POST /internal/x/repair-subscriptions — see ensureXSubscriptions.
          const result = await ensureXSubscriptions(env, row.id, config, creds, newToken);
          if (!result.ok) console.error(JSON.stringify({ event: "xaa_subscription_repair_skipped", channel_id: row.id, reason: result.error }));
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

// 预算与 handlePolling 同量级（50s，两者在同一个 allSettled 里并发跑，cron 的总墙钟时间
// 因此不变）。原来的 20s 是从 handleYouTubeSubscriptions 抄来的，但那个循环是**每账号**
// 且自带 23 小时节流，绝大多数轮次直接跳过、几乎不花钱；这个循环是**每 (channel, repo)**
// 且没有任何节流，每一轮每一对都实打实要 ~5 次 D1 加一次 GitHub 往返，实测约 250–450ms。
// 也就是说一轮能处理的对数大约是：20s → 45~80 对，50s → 110~200 对。
// 预算本身**不**是防饿死的机制（那是下面的轮转位点），它只决定「最坏等多少轮」。
const GITHUB_RELEASES_BUDGET_MS = 50_000;

/** 轮转位点在 cron_state 里的键。值是上一轮最后**考察过**的那一对的 pairKey。 */
const GITHUB_ROTATION_KEY = "github_releases_rotation";

/** watch 清单里一对 (channel, repo) 的稳定标识；排序与轮转位点都用它。 */
function pairKey(w: { channelId: string; fullName: string }): string {
  return `${w.channelId}|${w.fullName}`;
}

/**
 * GitHub release 轮询。像 handleYouTubeSubscriptions 一样拿自己的顶层预算，不挤
 * handlePolling 那个 50 秒配额池 —— 那个池按 channel 排队且没有 ORDER BY，排在后面的
 * 永远被饿死（YouTube 订阅同步就是这么被饿死过的）。
 *
 * 要盯哪些 repo 的唯一真相来源是 flow 的 graph_json（同 /internal/list-watches、
 * /internal/youtube-watches）：flow 里删掉节点，下一轮自然不再轮询，无需反向清理。
 *
 * === 不饿死任何租户的保证 ===
 * /internal/github-watches 的 SELECT 没有 ORDER BY，返回顺序在多轮之间基本稳定，所以
 * 「每轮都从头开始 + 预算耗尽就 break」等价于：排在预算边界之后的租户**永远**不被轮询，
 * 不是晚一点，是一次都没有 —— 他们已发布的 flow 静默地永不触发。
 *
 * 这里改成**环形轮转**：
 *   1. 先按 pairKey 排序，让「第 i 个位置」在轮与轮之间有确定含义（清单本身的顺序不可信）；
 *   2. 从 cron_state 里读上一轮最后考察过的 pairKey，从它的**下一个**位置开始，走到头就绕回 0；
 *   3. 每考察一对就推进位点 —— 无论它是被轮询了、被 stoppedChannels 跳过了、还是抛错了。
 *      「失败也推进」是关键：否则一个每轮都失败的 pair 会把位点钉死在原地，饿死效应原样复发。
 *   4. 本轮结束把位点写回去；一对都没考察到（预算一开始就用光）时不写，位点保持不动。
 * 由此得到的硬保证：设清单长度 N、一轮能处理 B 对，则**任何**一对最多等 ceil(N/B) 轮
 * （即 ceil(N/B) 小时）必被轮询到一次。位点丢失或清单变动只会让某一轮的起点漂移，
 * 绕环这件事本身不受影响，永久饿死这个状态不存在。
 * 观测：github_releases_budget_exhausted 会报出本轮跳过了多少对（skipped），
 * 用它除以 total 就能判断预算是否需要再调。
 */
export async function handleGitHubReleases(env: Env): Promise<void> {
  // 配置级总开关。这条链路会公开发帖、给真人发私信，出问题时必须有一个不改代码就能拉下的闸
  // （改 wrangler.toml 的 var 或在 Cloudflare 控制台改同名变量即可）。缺省 = 开，
  // 只有显式写成 "0"/"false" 才关，行为与加这个开关之前一致。
  if (!githubReleasesEnabled(env)) {
    console.log(JSON.stringify({ event: "github_releases_disabled" }));
    return;
  }

  const runDeadline = Date.now() + GITHUB_RELEASES_BUDGET_MS;

  // 与 handleYouTubeRenewal 同样兜住：拿不到/读不懂 watch 清单就什么都不做。没有清单时
  // 继续往下走没有任何意义，而一个网络异常逃出去会让本 handler 整体消失在 allSettled 里，
  // 连一行可查的日志都不留。
  let watches: { channelId: string; fullName: string }[];
  try {
    const res = await fetch(`${env.FLOW_URL}/internal/github-watches`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "github_watches_fetch_failed", status: res.status }));
      return;
    }
    const body = (await res.json()) as { watches?: { channelId: string; fullName: string }[] };
    watches = body.watches ?? [];
  } catch (e) {
    console.error(JSON.stringify({ event: "github_watches_fetch_error", error: String(e) }));
    return;
  }
  if (watches.length === 0) {
    console.log(JSON.stringify({ event: "github_watches_fetched", count: 0 }));
    return;
  }

  // 排序 + 轮转起点：见上面的「不饿死任何租户的保证」。
  const ordered = [...watches].sort((a, b) => (pairKey(a) < pairKey(b) ? -1 : pairKey(a) > pairKey(b) ? 1 : 0));
  const resumeKey = await readCronState(env, GITHUB_ROTATION_KEY);
  const resumeIdx = resumeKey ? ordered.findIndex((w) => pairKey(w) === resumeKey) : -1;
  // 找不到（首次运行 / 那一对已从清单里消失）就从头开始，不是错误分支。
  const start = resumeIdx >= 0 ? (resumeIdx + 1) % ordered.length : 0;
  console.log(JSON.stringify({
    event: "github_watches_fetched", count: ordered.length, resume_key: resumeKey, start_index: start,
  }));

  // 一个 channel 的 token 与租户只查一次，watches 里同一 channel 通常有多个 repo。
  const channelCache = new Map<string, { token: string; tenantId: number } | null>();
  // 本轮已经 401 或已限流的 channel，跳过它剩下的 repo。
  const stoppedChannels = new Set<string>();

  // 本轮最后考察过的一对；无论结果如何都推进（理由见上面第 3 点）。
  let lastExaminedKey: string | null = null;
  let examined = 0;

  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[(start + i) % ordered.length];
    if (Date.now() >= runDeadline) {
      // skipped 是给「预算够不够」定量用的：本轮还剩多少对没轮到。只报 repo 名的话，
      // 缺的恰好就是唯一能拿来调预算的那个数。
      console.log(JSON.stringify({
        event: "github_releases_budget_exhausted",
        repo: w.fullName, channel_id: w.channelId,
        examined, skipped: ordered.length - i, total: ordered.length,
      }));
      break;
    }
    lastExaminedKey = pairKey(w);
    examined++;

    if (stoppedChannels.has(w.channelId)) continue;

    if (!channelCache.has(w.channelId)) {
      const row = await env.LINK_DB
        // tenant-scope-ok: channelId 来自 flow 的 graph_json，此处按主键取行并回读 tenant_id 供下游使用
        .prepare("SELECT config, tenant_id FROM channels WHERE id = ? AND channel_type = 'GITHUB' AND is_active = 1")
        .bind(w.channelId)
        .first<{ config: string; tenant_id: number | null }>();
      const config = row ? (JSON.parse(row.config) as { access_token?: string }) : null;
      channelCache.set(
        w.channelId,
        config?.access_token && row?.tenant_id ? { token: config.access_token, tenantId: row.tenant_id } : null
      );
    }
    const channel = channelCache.get(w.channelId);
    if (!channel) continue;

    try {
      const { rateLimited } = await pollGitHubRepo(env, w.channelId, w.fullName, channel.token, channel.tenantId);
      if (rateLimited) {
        // 限流是**每 token**的：这个 channel 剩下的 repo 打过去只会一个个换回 403，
        // 每次还要 ~300ms —— 烧的是全平台共用的这份预算，等于一个租户就能把一小时占满，
        // 把所有别的租户挡在门外。所以立刻停掉它本轮剩下的 repo（与 401 同一个出口，
        // 区别是不停用 channel：限流是暂时的，下一轮自然恢复）。
        stoppedChannels.add(w.channelId);
        console.log(JSON.stringify({ event: "github_channel_rate_limited", channel_id: w.channelId, repo: w.fullName }));
      }
    } catch (e) {
      if (e instanceof GitHubUnauthorizedError) {
        // token 失效：停掉这个 channel 本轮的所有 repo，并标记需重连。
        stoppedChannels.add(w.channelId);
        await env.LINK_DB
          .prepare("UPDATE channels SET is_active = 0, deactivated_reason = 'github_unauthorized', updated_at = datetime('now') WHERE id = ?")
          .bind(w.channelId)
          .run();
        console.error(JSON.stringify({ event: "github_channel_unauthorized", channel_id: w.channelId }));
        continue;
      }
      console.error(JSON.stringify({ event: "github_releases_poll_error", channel_id: w.channelId, repo: w.fullName, error: String(e) }));
    }
  }

  if (lastExaminedKey) await writeCronState(env, GITHUB_ROTATION_KEY, lastExaminedKey);
}

/** 缺省开；只有显式的 "0" / "false"（忽略大小写与空白）才关。 */
export function githubReleasesEnabled(env: Env): boolean {
  const v = (env.GITHUB_RELEASES_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false";
}

// cron_state：跨 cron 轮次的小标量状态（目前只有 GitHub 轮询的轮转位点）。故意不塞进
// channel_poll_state —— 那张表的主键是 (channel_id, poller_name)，轮转位点不属于任何
// 单个 channel，硬塞会造出一行永远对不上 channels 的孤儿。
// 读写都兜住异常：位点是**优化**，轮询本身不该因为它挂掉。最现实的一种失败是迁移 0010
// 还没跑（手工部署跳过了 migrate 这一步）—— 那时让整个 handler 抛进 allSettled，等于
// GitHub 轮询整个停摆；退化成「每轮从头开始」明显更好。退化必须留痕，所以照样打 error 日志。
async function readCronState(env: Env, name: string): Promise<string | null> {
  try {
    const row = await env.LINK_DB
      .prepare("SELECT value FROM cron_state WHERE name = ?")
      .bind(name)
      .first<{ value: string | null }>();
    return row?.value ?? null;
  } catch (e) {
    console.error(JSON.stringify({ event: "cron_state_read_failed", name, error: String(e) }));
    return null;
  }
}

async function writeCronState(env: Env, name: string, value: string): Promise<void> {
  try {
    await env.LINK_DB
      .prepare(
        `INSERT INTO cron_state (name, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(name, value)
      .run();
  } catch (e) {
    console.error(JSON.stringify({ event: "cron_state_write_failed", name, error: String(e) }));
  }
}

/**
 * 组装 ContentService 并跑一个 (channel, repo) 的轮询。装配顺序与 poll-channel.ts 里
 * X/TikTok 那两条路径一致：resolveTenantDb → EntityStateStore → new ContentService。
 * GitHubUnauthorizedError 故意不在这里吞掉 —— 它要逃到 handleGitHubReleases 才能停掉
 * 该 channel 本轮剩下的 repo 并标记需重连。
 */
async function pollGitHubRepo(
  env: Env,
  channelId: string,
  fullName: string,
  token: string,
  tenantId: number
): Promise<{ rateLimited: boolean }> {
  // 与 pollXChannel/pollTikTokChannel 同一处检查点：租户还没开库就别花外部 API 配额。
  // release 是 flowType:"trigger"，本身不落 tenantDb，但保持「是否已开库」这一个统一
  // 关卡比为这条路径开特例更可靠（同 pollXListPosts 的理由）。
  const tenantDb = await resolveTenantDb(env, tenantId);
  if (!tenantDb) {
    console.log(JSON.stringify({ event: "github_releases_poll_skipped_no_tenant_db", channel_id: channelId, repo: fullName, tenant_id: tenantId }));
    return { rateLimited: false };
  }

  const entityState = new EntityStateStore(env.LINK_DB, tenantId);
  const contentService = new ContentService(
    tenantDb, env.VECTORIZE, env.AI, tenantId, env.PIPELINE_CONTENT, env.FLOW_QUEUE, entityState
  );

  return await runGitHubReleasePoller({
    channelId,
    fullName,
    token,
    tenantId,
    linkDb: env.LINK_DB,
    contentService,
    now: Date.now(),
  });
}
