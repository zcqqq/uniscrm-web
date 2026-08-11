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
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return [];

  const db = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
  try {
    const rows = await db.query<{ channel_type: string; title: string | null; content_text: string | null }>(
      "SELECT channel_type, title, content_text FROM content ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map((r) => ({ channelType: r.channel_type, title: r.title, contentText: r.content_text }));
  } catch (err) {
    console.error(JSON.stringify({ event: "tenant_content_read_failed", tenantId, error: String(err) }));
    return [];
  }
}
