import { r2Query, latestRowsSql, sqlStr, sqlInt, type R2SqlEnv } from "../../../shared/r2-sql";
import type { ContentRow } from "../types";

// is_deleted must be selected (not just filtered) so it can (a) be applied as a post-dedup
// outerWhere filter — see shared/r2-sql.ts's latestRowsSql doc comment for why a pre-QUALIFY
// is_deleted filter resurrects deleted rows — and (b) be read back by callers like
// ContentService.update/delete that need to see a row's current deleted-ness.
export const CONTENT_COLUMNS = [
  "id", "channel_id", "channel_type", "content_type", "source_content_id", "list_id",
  "title", "content_text", "summary", "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "impression_count", "view_count", "like_count",
  "quote_count", "reply_count", "repost_count", "share_count",
  "raw_data", "created_at", "updated_at", "is_deleted",
];

export const USER_COLUMNS = [
  "id", "channel_id", "channel_type", "source_user_id", "name", "username",
  "is_active", "is_follow", "is_followed", "verified_type", "profile_image_url", "description",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
  "raw_data", "created_at", "updated_at", "is_deleted",
];

const CONTENT_PARTITION = ["channel_id", "list_id", "source_content_id"];
const USER_PARTITION = ["channel_id", "source_user_id"];

export async function listContents(
  env: R2SqlEnv,
  tenantId: number,
  channelType?: string
): Promise<ContentRow[]> {
  const where = [`tenant_id = ${sqlInt(tenantId)}`];
  if (channelType) where.push(`channel_type = ${sqlStr(channelType)}`);
  return await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where,
      // is_deleted is a post-dedup condition (§ latestRowsSql doc comment) — it must run on the
      // row QUALIFY already picked as latest, never on the raw pre-dedup rows.
      outerWhere: ["is_deleted = 0"],
      // Most rows never get source_updated_at (only resolvable via CONTENT_COLUMN_MAP paths
      // syncBatch's ChannelItem provides); ordering by it alone put every poller-ingested row
      // into one undefined-order block. Fall back through the audit trail instead.
      orderBy: "COALESCE(source_updated_at, source_created_at, created_at) DESC",
      limit: 1000,
    })
  );
}

export async function getContent(
  env: R2SqlEnv,
  tenantId: number,
  id: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<ContentRow | null> {
  const rows = await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id = ${sqlStr(id)}`],
      // Callers that need to see a deleted row's current state (ContentService.update/delete,
      // which must distinguish "not found" from "found but deleted") pass includeDeleted; every
      // other reader gets is_deleted filtered out post-dedup, per 「所有读路径带 AND is_deleted = 0」.
      outerWhere: opts.includeDeleted ? undefined : ["is_deleted = 0"],
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
      where: [`tenant_id = ${sqlInt(tenantId)}`],
      outerWhere: ["is_deleted = 0"],
      orderBy: "updated_at DESC",
      limit,
    })
  );
}

// Powers XUsersService.upsertUser's read-modify-write (task-5 fix round, Important 2): the
// webhook path only ever knows name/username/profile_image_url, never follower counts — so an
// existing user's R2 row must be read and merged first, or every webhook touch would null out
// the columns the poller last populated. Same is_deleted placement as every other reader here:
// it must run in outerWhere (post-QUALIFY), never in `where` — folding it into the pre-dedup
// WHERE would drop the tombstone from the window's input and let the pre-delete row win (the
// Task 4 bug).
export async function getUserBySource(
  env: R2SqlEnv,
  tenantId: number,
  channelId: string,
  sourceUserId: string
): Promise<Record<string, unknown> | null> {
  const rows = await r2Query<Record<string, unknown>>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: USER_COLUMNS,
      partitionBy: USER_PARTITION,
      where: [
        `tenant_id = ${sqlInt(tenantId)}`,
        `channel_id = ${sqlStr(channelId)}`,
        `source_user_id = ${sqlStr(sourceUserId)}`,
      ],
      outerWhere: ["is_deleted = 0"],
      limit: 1,
    })
  );
  return rows[0] ?? null;
}

export interface UserDisplayName {
  name: string | null;
  username: string | null;
}

// Batch id -> {name, username} lookup for rendering a list of users without a full row read
// per id (e.g. list-membership pages). Renamed from getUserNames (task-6 fix round 1,
// Important 2): the old version only projected `name`, so every caller silently rendered
// `username` as null — a real UI regression, not a stylistic gap. General-purpose enough to
// reuse from flow (Task 8) without another rename: add fields here, not a second function.
export async function getUserDisplayNames(
  env: R2SqlEnv,
  tenantId: number,
  ids: string[]
): Promise<Map<string, UserDisplayName>> {
  if (ids.length === 0) return new Map();
  const list = ids.map(sqlStr).join(", ");
  const rows = await r2Query<{ id: string; name: string | null; username: string | null }>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "name", "username", "is_deleted"],
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id IN (${list})`],
      outerWhere: ["is_deleted = 0"],
    })
  );
  return new Map(rows.map((r) => [r.id, { name: r.name ?? null, username: r.username ?? null }]));
}

// list_users.user_id is a MIXED population of two id domains (final review I3): a member added
// through the UI (POST /api/lists/:id/users) carries `uniscrm.user.id` — the uuid
// link/src/services/entity-state.ts's EntityStateStore.claim() mints — while a member flow's
// addToList action adds (POST /internal/lists/:id/users, called from flow/src/index.ts's
// executeActions) carries flow's own user identity: the EXTERNAL platform id (X's numeric user
// id — see routes-internal.ts's body.userId, sourced from webhook.ts's `userId: userData.id`).
// A single `id IN (...)` lookup (getUserDisplayNames above) only ever resolves the first kind,
// leaving every flow-added row blank.
//
// Resolution strategy (deliberate choice, not a fallback-to-empty): query BOTH id domains in one
// round trip — `id IN (...) OR source_user_id IN (...)` — then for each requested value prefer an
// `id` match and fall back to a `source_user_id` match. This assumes a given list_users.user_id
// value is never simultaneously a valid uuid AND a valid X numeric id for two different rows
// (astronomically unlikely: uuids are 36-char hex-with-dashes, X ids are short decimal strings) —
// no coercion or heuristic is needed to tell the two domains apart, unlike the propId-vs-field-name
// trap this codebase has hit before. If the same X id was ever observed by two different bound
// channels (same real account followed via two X channels), source_user_id alone is ambiguous
// across channel_id — this picks whichever row R2 returns first for that id, which is a
// display-only tradeoff (name/username only), not a correctness-bearing one.
export async function getUserDisplayNamesMixed(
  env: R2SqlEnv,
  tenantId: number,
  ids: string[]
): Promise<Map<string, UserDisplayName>> {
  if (ids.length === 0) return new Map();
  const list = ids.map(sqlStr).join(", ");
  const rows = await r2Query<{ id: string; source_user_id: string; name: string | null; username: string | null }>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "source_user_id", "name", "username", "is_deleted"],
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `(id IN (${list}) OR source_user_id IN (${list}))`],
      outerWhere: ["is_deleted = 0"],
    })
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySourceId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    // First match wins when the same external id was observed by more than one channel — see
    // the doc comment above.
    if (!bySourceId.has(r.source_user_id)) bySourceId.set(r.source_user_id, r);
  }

  const result = new Map<string, UserDisplayName>();
  for (const requested of ids) {
    const row = byId.get(requested) ?? bySourceId.get(requested);
    if (row) result.set(requested, { name: row.name ?? null, username: row.username ?? null });
  }
  return result;
}
