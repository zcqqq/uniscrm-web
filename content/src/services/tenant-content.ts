import type { Env } from "../types";
import { TenantDataDB } from "../../../shared/tenant-data-db";

const DEFAULT_LIMIT = 20;

export interface RecentContentRow {
  channelType: string;
  title: string | null;
  contentText: string | null;
}

// 起草用的信号源之一。租户没开库、或库查不动，都返回空数组：起草是锦上添花，
// 让它把整个端点拖成 500 不划算 —— 两个信号都空时对话会从白纸开始。
export async function listRecentTenantContent(
  env: Env,
  tenantId: number,
  limit = DEFAULT_LIMIT
): Promise<RecentContentRow[]> {
  try {
    const tenant = await env.WEB_DB
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ d1_database_id: string | null }>();
    // 新租户还没开库是常态，不是错误 —— 不记日志，静默退化成 []。
    if (!tenant?.d1_database_id) return [];

    const db = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
    const rows = await db.query<{ channel_type: string; title: string | null; content_text: string | null }>(
      "SELECT channel_type, title, content_text FROM content ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map((r) => ({ channelType: r.channel_type, title: r.title, contentText: r.content_text }));
  } catch (err) {
    // 这里落地的是"查询没查动"（WEB_DB 定位失败或 per-tenant D1 查询失败），
    // 与上面"租户没开库"的静默 [] 是两回事：调试空草稿时靠有没有这条日志区分。
    console.error(JSON.stringify({ event: "tenant_content_read_failed", tenantId, error: String(err) }));
    return [];
  }
}
