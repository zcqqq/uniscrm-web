import { r2Query, latestRowsSql, sqlStr, sqlInt, type R2SqlEnv } from "../../../shared/r2-sql";

export const USER_COLUMNS = [
  "id", "channel_id", "channel_type", "source_user_id", "name", "username",
  "is_active", "is_follow", "is_followed", "verified_type", "profile_image_url", "description",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
  "raw_data", "created_at", "updated_at", "is_deleted",
];

const USER_PARTITION = ["channel_id", "source_user_id"];

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

export interface UserDisplayName {
  name: string | null;
  username: string | null;
}

// list_users.user_id is a MIXED population of two id domains (final review I3): a member added
// through the UI (POST /api/lists/:id/users) carries `uniscrm.user.id` — the uuid per-tenant
// D1's INSERT ... RETURNING mints (2026-07-26 plan; entity_state.ts's EntityStateStore.claim()
// used to mint this before user truth moved back to D1, and was deleted in task 9's dead-code
// sweep) — while a member flow's addToList action adds (POST /internal/lists/:id/users, called
// from flow/src/index.ts's
// executeActions) carries flow's own user identity: the EXTERNAL platform id (X's numeric user
// id — see routes-internal.ts's body.userId, sourced from webhook.ts's `userId: userData.id`).
// A single `id IN (...)` lookup (this module's now-deleted getUserDisplayNames — task 9b, zero
// production callers; flow/src/index.ts's getUserNames mirrors its old column set independently
// instead of importing across the module boundary) only ever resolves the first kind, leaving
// every flow-added row blank.
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
