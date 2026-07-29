import type { Env } from "../types";
import { YouTubeTokenService } from "./youtube-token";
import { EntityStateStore } from "./entity-state";
import { resolveTenantDb } from "./tenant-db";
import { runYouTubeSubscriptionsPoller } from "./pollers/youtube-subscriptions";

// OAuth 连接后立即跑一次，之后由每天一次的 cron 接手（poll-channel.ts）。两条路径
// 共用这一个入口，是为了让「一个 YouTube 账号跑一轮订阅同步」只有一份实现。
// budgetMs 默认给 OAuth 的 waitUntil 留余量；cron 侧传自己的 per-channel 预算。
export async function syncYouTubeSubscriptionUsers(
  env: Env,
  accountChannelId: string,
  budgetMs = 25_000
): Promise<void> {
  const row = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT' AND is_active = 1")
    .bind(accountChannelId)
    .first<{ id: string; config: string; tenant_id: number | null }>();
  if (!row || !row.tenant_id) return;

  // 在任何 YouTube API 调用（含 token 刷新）之前守住 —— 存不下就别抓。
  const tenantDb = await resolveTenantDb(env, row.tenant_id);
  if (!tenantDb) {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_sync_skipped_no_tenant_db",
      account_channel_id: accountChannelId, tenant_id: row.tenant_id,
    }));
    return;
  }

  let syncStatus = "done";
  try {
    const tokenService = new YouTubeTokenService(env.LINK_DB, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(accountChannelId);

    await runYouTubeSubscriptionsPoller({
      env,
      accountChannelId,
      accessToken,
      linkDb: env.LINK_DB,
      tenantDb,
      entityState: new EntityStateStore(env.LINK_DB, row.tenant_id),
      tenantId: row.tenant_id,
      pipelineUser: env.PIPELINE_USER,
      deadline: Date.now() + budgetMs,
    });
  } catch (e) {
    syncStatus = "error";
    console.error(JSON.stringify({
      event: "youtube_subscriptions_sync_error",
      account_channel_id: accountChannelId, error: String(e),
    }));
  }

  // json_set 定点改这两个 key，绝不整体重写 config —— YouTubeTokenService.forceRefresh
  // 会整体重写 config，读改写会与它互相覆盖（本仓库在 X 冻结标记上踩过这个坑）。
  await env.LINK_DB
    .prepare(
      `UPDATE channels
          SET config = json_set(config, '$.sync_status', ?, '$.last_synced_at', ?),
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(syncStatus, new Date().toISOString(), accountChannelId)
    .run();
}
