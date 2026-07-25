import { r2Query, latestRowsSql, sqlStr, sqlInt, type R2SqlEnv } from "../../../shared/r2-sql";
import type { ContentRow } from "../types";

export const CONTENT_COLUMNS = [
  "id", "channel_id", "channel_type", "content_type", "source_content_id", "list_id",
  "title", "content_text", "summary", "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "impression_count", "view_count", "like_count",
  "quote_count", "reply_count", "repost_count", "share_count",
  "raw_data", "created_at", "updated_at",
];

export const USER_COLUMNS = [
  "id", "channel_id", "channel_type", "source_user_id", "name", "username",
  "is_active", "is_follow", "is_followed", "verified_type",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
  "raw_data", "created_at", "updated_at",
];

const CONTENT_PARTITION = ["channel_id", "list_id", "source_content_id"];
const USER_PARTITION = ["channel_id", "source_user_id"];

export async function listContents(
  env: R2SqlEnv,
  tenantId: number,
  channelType?: string
): Promise<ContentRow[]> {
  const where = [`tenant_id = ${sqlInt(tenantId)}`, "is_deleted = 0"];
  if (channelType) where.push(`channel_type = ${sqlStr(channelType)}`);
  return await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where,
      orderBy: "source_updated_at DESC",
      limit: 1000,
    })
  );
}

export async function getContent(
  env: R2SqlEnv,
  tenantId: number,
  id: string
): Promise<ContentRow | null> {
  const rows = await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id = ${sqlStr(id)}`],
      limit: 1,
    })
  );
  return rows[0] ?? null;
}

export async function listUsers(
  env: R2SqlEnv,
  tenantId: number,
  limit: number
): Promise<Record<string, unknown>[]> {
  return await r2Query<Record<string, unknown>>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: USER_COLUMNS,
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, "is_deleted = 0"],
      orderBy: "updated_at DESC",
      limit,
    })
  );
}

export async function getUserNames(
  env: R2SqlEnv,
  tenantId: number,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const list = ids.map(sqlStr).join(", ");
  const rows = await r2Query<{ id: string; name: string | null }>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "name"],
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id IN (${list})`],
    })
  );
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
}
