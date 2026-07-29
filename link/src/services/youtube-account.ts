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
  // 行本身不存在：没有可写状态的载体，也就没有卡在 pending 的卡片可言。
  if (!row) return;

  // OAuth 回调把 sync_status 写成 "pending"，前端每 2 秒轮询一次 /youtube/status 直到它
  // 不再是 pending。因此**每一条**提前返回都必须先落一个终态 —— 否则未 provision 的租户
  // （tenant 创建与 provision 之间的真实中间态）连上 YouTube 后，卡片会永远停在
  // 「正在同步你的订阅…」，页面在其整个生命周期里每 2 秒打一次请求。
  if (!row.tenant_id) {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_sync_skipped_no_tenant",
      account_channel_id: accountChannelId,
    }));
    await writeSyncStatus(env, accountChannelId, "error");
    return;
  }

  // 在任何 YouTube API 调用（含 token 刷新）之前守住 —— 存不下就别抓。
  const tenantDb = await resolveTenantDb(env, row.tenant_id);
  if (!tenantDb) {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_sync_skipped_no_tenant_db",
      account_channel_id: accountChannelId, tenant_id: row.tenant_id,
    }));
    await writeSyncStatus(env, accountChannelId, "error");
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

  await writeSyncStatus(env, accountChannelId, syncStatus);
}

// json_set 定点改这两个 key，绝不整体重写 config —— YouTubeTokenService.forceRefresh
// 会整体重写 config，读改写会与它互相覆盖（本仓库在 X 冻结标记上踩过这个坑）。
//
// 这一步本身也必须兜住异常：D1 REST 调用真的会失败，而调用方存在的全部理由就是
// 「不能让任何异常从这里逃出去到 OAuth 回调的 waitUntil 里」——丢一个 sync_status
// 标记只是前端卡片显示旧状态（美观退化），异常逃逸出去才是 OAuth 已经写成功的连接
// 却让用户看到报错页（要严防的那类错误）。
async function writeSyncStatus(env: Env, accountChannelId: string, syncStatus: string): Promise<void> {
  try {
    await env.LINK_DB
      .prepare(
        `UPDATE channels
            SET config = json_set(config, '$.sync_status', ?, '$.last_synced_at', ?),
                updated_at = datetime('now')
          WHERE id = ?`
      )
      .bind(syncStatus, new Date().toISOString(), accountChannelId)
      .run();
  } catch (e) {
    console.error(JSON.stringify({
      event: "youtube_subscriptions_sync_status_write_failed",
      account_channel_id: accountChannelId, sync_status: syncStatus, error: String(e),
    }));
  }
}
