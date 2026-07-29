import type { TenantDataDB } from "../../../shared/tenant-data-db";
import type { Pipeline } from "../types";
import { EntityStateStore, type EntityStateKey } from "./entity-state";
import { resolveProps, consumedPaths } from "./pollers/resolve-props";
import { UserMetadata_X } from "../../../metadata/x-byok";
import type { UserMetadata } from "../../../metadata/dataTypes";

// X nests the counts under public_metrics and names some fields differently from our
// propIds (post_count -> tweet_count), so the propId -> payload path mapping has to come
// from metadata, never from the propId itself. `value`-only mappings are excluded: they
// describe a poller's fixed context (own:get-followers implies is_followed = 1) and must
// not be asserted for a user arriving through some other path.
const X_USER_META = UserMetadata_X.find((m) => m.sourceUserType === "own:get-followers");
const X_USER_MAPPINGS = (X_USER_META?.userProps || []).filter((m) => m.dataId);

// Every value column of the `user` entity, i.e. everything except the key/audit columns each
// write builds explicitly (tenant_id, id, channel_id, channel_type, source_user_id, is_active,
// is_follow, is_followed, raw_data, is_deleted, created_at, updated_at). One list drives BOTH
// stores on purpose (same rule as content.ts's CONTENT_COLUMN_MAP): per-tenant D1 is the source
// of truth (2026-07-26 plan: user/content back to per-tenant D1) and the R2 Iceberg `user`
// table is an analytics-only copy of the same row. The D1 schema
// (admin/src/services/tenant-init-sql.ts) is a superset — every column named here exists in
// both. Keep in sync with analytics/pipelines/user-stream-schema.json.
//
// This is ALSO the probe/compare projection that decides whether anything actually changed. It
// replaces the entity_state fingerprint the R2-as-truth phase used: D1 holds the previous
// values, so a plain column compare is both cheaper (no hashing) and exact. It is also what
// makes the two writers agree — the webhook knows name/username/profile_image_url, the poller
// knows all of them, and both now diff against the SAME stored row instead of against each
// other's fingerprint. created_at/updated_at are deliberately excluded, or every call would
// look "changed".
const USER_VALUE_COLUMNS = [
  "name", "username", "verified_type", "profile_image_url", "description",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
];

// The two follow columns. They live on the `user` row in D1 (NOT NULL DEFAULT 0) and as fixed
// base columns on the R2 record, so they are tracked separately from USER_VALUE_COLUMNS: only a
// caller that actually KNOWS a follow bit ever writes it, which is 461d039's CASE WHEN guard
// restated — an upsert that says nothing about following must never reset a stored 1 to 0.
const USER_FOLLOW_COLUMNS = ["is_follow", "is_followed"] as const;

// propIds that land in a named column — source_user_id (the entity key itself) plus every
// USER_VALUE_COLUMNS entry. Used to filter consumedPaths() so a mapped-but-columnless prop is
// never treated as "consumed" and stripped out of raw_data, which would destroy it with nowhere
// else to land (task-5 fix round, Important 1). profile_image_url and description USED to be in
// that category; they became real columns once the Users list was seen rendering both as blank.
const MAPPED_USER_PROP_IDS = new Set<string>(["source_user_id", ...USER_VALUE_COLUMNS]);

// R2 event pipeline's value columns beyond the fixed identity/time columns every write
// builds explicitly. Keep in sync with analytics/pipelines/event-stream-schema.json.
// Exported so a caller computing consumedPaths for an eventProps array (webhook.ts) can pass
// this as consumedPaths' allowedPropIds filter, mirroring MAPPED_USER_PROP_IDS above — same
// "mapped-but-columnless" guard, applied to the event pipeline instead of the user one.
export const EVENT_VALUE_COLUMNS = ["followers_count", "following_count", "verified_type", "message_text"];

export interface XUserData {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  description?: string;
  location?: string;
  url?: string;
  verified?: boolean;
  verified_type?: string;
  protected?: boolean;
  created_at?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
  [key: string]: unknown;
}

// The existing `user` row a write diffs and merges against, and the shape RETURNING gives back.
type UserProbeRow = Record<string, unknown> & {
  id: string;
  created_at: string;
  is_follow: number | null;
  is_followed: number | null;
};

// Deep-clones `payload` and deletes each dotted `path` (e.g. "public_metrics.followers_count")
// from it — the complement of what resolveProps consumed, per consumedPaths in
// pollers/resolve-props.ts. Tolerates a path that doesn't exist (nothing to delete). Leaves a
// parent object in place even if removing its last child empties it — this strips consumed
// leaves, it doesn't reshape the payload. (Same approach as content.ts's stripConsumedPaths —
// duplicated here rather than shared because it isn't exported; see the raw_data trap note in
// the task-5 brief: propId ≠ payload field name, so stripping must go by dataId path.)
function stripConsumedPaths(payload: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  for (const path of paths) {
    const parts = path.split(".");
    let current: unknown = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current == null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[parts[i]];
    }
    if (current != null && typeof current === "object") {
      delete (current as Record<string, unknown>)[parts[parts.length - 1]];
    }
  }
  return clone;
}

export class UsersService {
  private pipelineEvent?: Pipeline;
  private pipelineUser?: Pipeline;
  private tenantId?: number;
  private entityState?: EntityStateStore;
  // Warn at most once per instance that the follow mirror is disabled: the followers poller
  // resolves is_followed for EVERY follower on EVERY page, so a per-call warn would bury the log.
  private warnedNoEntityState = false;

  constructor(
    // Per-tenant D1 — the source of truth. Nullable because a tenant's database may not be
    // provisioned yet (middleware only injects it when tenants.d1_database_id is set); every
    // method that needs it says so loudly through requireDb() rather than dying on
    // `undefined.query`. Mirrors ContentService's first constructor argument.
    private tenantDb: TenantDataDB | null,
    // `queue` is accepted but deliberately unused: it belonged to the removed upsertUsers()
    // profile-enrichment batch path. It stays in the signature because Task 7's callers pass it
    // and these signatures are pinned verbatim; nothing in this class consumes it.
    opts?: {
      queue?: Queue;
      pipelineEvent?: Pipeline;
      pipelineUser?: Pipeline;
      tenantId?: number;
      entityState?: EntityStateStore;
    }
  ) {
    this.pipelineEvent = opts?.pipelineEvent;
    this.pipelineUser = opts?.pipelineUser;
    this.tenantId = opts?.tenantId;
    this.entityState = opts?.entityState;
  }

  private requireDb(method: string): TenantDataDB {
    if (!this.tenantDb) {
      throw new Error(`UsersService.${method}: tenantDb is required (tenant DB not provisioned)`);
    }
    return this.tenantDb;
  }

  // Builds a complete R2 `user` row: every value column present, explicit null when
  // unknown. `values` only needs to carry the columns this call site actually knows —
  // everything else in USER_VALUE_COLUMNS is filled in as null.
  private buildUserRecord(
    base: {
      id: string;
      channelId: string;
      channelType: string;
      sourceUserId: string;
      isFollow: 0 | 1;
      isFollowed: 0 | 1;
      rawData: string;
      createdAt: string;
      updatedAt: string;
      isDeleted?: 0 | 1;
    },
    values: Record<string, unknown>
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      tenant_id: this.tenantId,
      id: base.id,
      channel_id: base.channelId,
      source_user_id: base.sourceUserId,
      channel_type: base.channelType,
      is_active: 1,
      is_follow: base.isFollow,
      is_followed: base.isFollowed,
      raw_data: base.rawData,
      is_deleted: base.isDeleted ?? 0,
      created_at: base.createdAt,
      updated_at: base.updatedAt,
    };
    for (const col of USER_VALUE_COLUMNS) {
      record[col] = values[col] ?? null;
    }
    return record;
  }

  private buildEventRecord(
    base: {
      id: string;
      userId: string;
      channelId: string;
      eventType: string;
      eventTime: string;
      rawData: string;
      createdAt: string;
    },
    values: Record<string, unknown>
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      tenant_id: this.tenantId,
      id: base.id,
      user_id: base.userId,
      channel_id: base.channelId,
      event_type: base.eventType,
      event_time: base.eventTime,
      created_at: base.createdAt,
      raw_data: base.rawData,
    };
    for (const col of EVENT_VALUE_COLUMNS) {
      record[col] = values[col] ?? null;
    }
    return record;
  }

  // Fire-and-log. R2 is a copy, not the truth: by the time this runs the D1 write has already
  // committed, so a failed send must neither fail the caller nor roll anything back. That is a
  // deliberate, accepted downgrade (content.ts's sendContentRecord makes the same trade) — the
  // analytics copy of this row stays stale until the next REAL change to it, which is the price
  // of not letting an analytics-side outage break ingestion. The rollback-the-fingerprint dance
  // the R2-as-truth phase needed (sendUserRecordOrRollback) died with the fingerprints.
  private async sendUserRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.pipelineUser) return;
    await this.pipelineUser.send([record]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_user_error", userId: record.id, error: String(err) }));
    });
  }

  // entity_state is no longer the user's identity store (D1 mints the id now), but its two
  // follow columns ARE still flow's hot read on every action (flow/src/index.ts's
  // resolveUserPropsForFilter, keyed by channel_id + the EXTERNAL X id, never by entity_id), so
  // every user write must keep them current. The row is created carrying entity_id = the id D1
  // just returned, so the two stores never disagree about which uuid this user is.
  //
  // Called from BOTH write paths, in the same call as the D1 write: the previous round's
  // Critical 1 was exactly a missed mirror on the poller path — entity_state.is_followed stayed
  // NULL forever for a poller-discovered follower, so every flow action gated on is_followed
  // silently skipped that user.
  private async mirrorFollowState(
    key: EntityStateKey,
    entityId: string,
    follow: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<void> {
    if (!this.entityState) {
      if (!this.warnedNoEntityState) {
        this.warnedNoEntityState = true;
        console.warn(JSON.stringify({
          event: "user_follow_mirror_disabled",
          message: "entityState not configured — flow's is_follow/is_followed hot read will not be maintained",
          channelId: key.channelId,
        }));
      }
      return;
    }
    // INSERT OR IGNORE, so re-upserting a known user keeps the entity_id already stored rather
    // than churning it (flow logs / list membership reference it).
    await this.entityState.ensureEntity(key, entityId);
    if (follow.is_follow !== undefined) await this.entityState.setFollow(key, "is_follow", follow.is_follow);
    if (follow.is_followed !== undefined) await this.entityState.setFollow(key, "is_followed", follow.is_followed);
  }

  // The single D1 write both public upsert paths go through: probe -> merge -> upsert -> mirror
  // -> R2 copy. `columnValues` carries only the USER_VALUE_COLUMNS this caller actually knows,
  // `followValues` only the follow bits it actually knows. Anything absent is left untouched in
  // D1 (it is simply not in the SET list) — the read-modify-write shape 461d039 expressed as
  // per-column CASE WHEN, restated as dynamic columns the way content.ts does it.
  private async persistUser(params: {
    channelId: string;
    channelType: string;
    sourceUserId: string;
    columnValues: Record<string, unknown>;
    followValues: { is_follow?: 0 | 1; is_followed?: 0 | 1 };
    rawData: string;
    // A follow-state change must still produce an R2 row even if every profile field is
    // byte-identical to the last snapshot: R2 has no column-wise update, so an R2 reader (the
    // Users list) would otherwise never see it.
    forceSend: boolean;
  }): Promise<{ id: string; isNew: boolean; unchanged: boolean }> {
    const { channelId, channelType, sourceUserId, columnValues, followValues, rawData } = params;
    const db = this.requireDb("persistUser");
    const now = new Date().toISOString();
    const key: EntityStateKey = { entity: "user", channelId, sourceId: sourceUserId };

    const existing = await db.query<UserProbeRow>(
      `SELECT id, created_at, ${USER_FOLLOW_COLUMNS.join(", ")}, ${USER_VALUE_COLUMNS.join(", ")} FROM user WHERE channel_id = ? AND source_user_id = ?`,
      [channelId, sourceUserId]
    );

    // The probe only PROPOSES an id: between it and the upsert another writer for the same
    // business key (a follow webhook vs. the followers poller's re-walk) can insert first, and
    // the upsert's DO UPDATE deliberately does not touch `id`, so D1 keeps the winner's. The
    // authoritative id therefore comes back from the write itself via RETURNING — see below.
    const probeIsNew = existing.length === 0;
    const prior = probeIsNew ? null : existing[0];
    const candidateId = prior ? prior.id : crypto.randomUUID();
    // Keep the copy's created_at equal to the truth's instead of stamping `now` on every
    // update — the R2 read path takes the newest row per key, so a re-stamped created_at would
    // make every row look as if it had been created at its last refresh.
    const candidateCreatedAt = prior ? String(prior.created_at ?? now) : now;

    const dynamicCols = Object.keys(columnValues);
    const followCols = Object.keys(followValues) as ("is_follow" | "is_followed")[];

    // Incremental pollers re-walk pages of already-known followers on every cron tick (see
    // pollers/x-followers.ts runIncrementalPoll). Without this check every visit would burn a D1
    // write AND append an identical row to the R2 copy, which has no dedup on write (append-only
    // Iceberg sink; see docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md). The
    // follow columns take part in the comparison, so a follow bit that actually flipped still
    // counts as a change and reaches D1. Columns this caller doesn't know are skipped rather
    // than treated as empty — the same vanished-value asymmetry content.ts documents (parity
    // with 461d039).
    const unchanged =
      !probeIsNew &&
      dynamicCols.every((c) => String(columnValues[c]) === String(prior![c] ?? "")) &&
      followCols.every((c) => String(followValues[c]) === String(prior![c] ?? ""));

    // The R2 copy must be the COMPLETE row (its read path takes one whole row per key via
    // QUALIFY ROW_NUMBER() = 1, so a column omitted from a write is a column nulled out). The
    // webhook only knows name/username/profile_image_url, so the merge source is the D1 probe
    // row — the truth — not the 1-3s R2 read of the R2-as-truth phase (getUserBySource is gone
    // from this file). Post-write this merged shape IS the D1 row: the upsert sets exactly
    // dynamicCols and leaves every other column as it was.
    const mergedValues: Record<string, unknown> = {};
    if (prior) for (const col of USER_VALUE_COLUMNS) mergedValues[col] = prior[col];
    Object.assign(mergedValues, columnValues);

    let id = candidateId;
    let createdAt = candidateCreatedAt;
    let isNew = probeIsNew;
    // Truth for the R2 record's follow bits: what D1 holds AFTER the write. When nothing was
    // written (unchanged) the probe row is that state.
    let isFollow = (prior?.is_follow ?? 0) as 0 | 1;
    let isFollowed = (prior?.is_followed ?? 0) as 0 | 1;

    if (!unchanged) {
      const writeCols = [...dynamicCols, ...followCols];
      const insertCols = ["id", "channel_id", "source_user_id", "channel_type", "raw_data", ...writeCols, "created_at", "updated_at"];
      const insertPlaceholders = insertCols.map(() => "?");
      const insertParams = [
        candidateId, channelId, sourceUserId, channelType, rawData,
        ...dynamicCols.map((c) => columnValues[c]),
        ...followCols.map((c) => followValues[c]),
        candidateCreatedAt, now,
      ];
      const updateSets = [
        // json_patch merges the new remainder into the stored one instead of replacing it, so a
        // partial payload (a webhook carrying fewer fields than the poller) can't wipe raw_data
        // keys an earlier, fuller write put there.
        "raw_data = json_patch(user.raw_data, excluded.raw_data)",
        "updated_at = excluded.updated_at",
        // Only the columns this caller knows. A column absent here keeps its stored value —
        // that IS the anti-clobber guarantee 461d039 spelled out as
        // `CASE WHEN excluded.x IS NOT NULL AND excluded.x != '' THEN excluded.x ELSE user.x END`.
        ...writeCols.map((c) => `${c} = excluded.${c}`),
      ];

      // RETURNING makes the WRITE authoritative for the id, closing the probe->mint->upsert
      // race: whether this statement inserted or hit the conflict, D1 hands back the row that
      // actually exists. Everything downstream — the entity_state mirror and the R2 copy — must
      // use that, or a lost race would ship an id matching no row in any store. Goes through
      // query() rather than run(), because run() discards result rows.
      const written = await db.query<UserProbeRow>(
        `INSERT INTO user (${insertCols.join(", ")})
         VALUES (${insertPlaceholders.join(", ")})
         ON CONFLICT(channel_id, source_user_id) DO UPDATE SET
           ${updateSets.join(",\n           ")}
         RETURNING id, created_at, is_follow, is_followed`,
        insertParams
      );

      if (written.length > 0 && written[0].id) {
        id = written[0].id;
        createdAt = String(written[0].created_at ?? candidateCreatedAt);
        isFollow = (written[0].is_follow ?? 0) as 0 | 1;
        isFollowed = (written[0].is_followed ?? 0) as 0 | 1;
        // A returned id other than the one just proposed means another writer inserted this key
        // first: the user is not new to the system, so the poller must not count it as new.
        isNew = probeIsNew && id === candidateId;
      } else {
        // Never expected — D1 returns a row for both the INSERT and the DO UPDATE branch. Log
        // loudly rather than silently reverting to the pre-fix (unverified id) behaviour.
        console.warn(JSON.stringify({
          event: "persistUser_upsert_returned_no_row",
          message: "INSERT ... RETURNING gave no row; falling back to the probe's proposed id",
          channelId,
          sourceUserId,
        }));
        isFollow = (followValues.is_follow ?? prior?.is_follow ?? 0) as 0 | 1;
        isFollowed = (followValues.is_followed ?? prior?.is_followed ?? 0) as 0 | 1;
      }
    }

    // Same call as the D1 write, always — see mirrorFollowState's comment (last round's C1).
    await this.mirrorFollowState(key, id, followValues);

    if ((!unchanged || params.forceSend) && this.pipelineUser && this.tenantId) {
      const record = this.buildUserRecord(
        { id, channelId, channelType, sourceUserId, isFollow, isFollowed, rawData, createdAt, updatedAt: now },
        mergedValues
      );
      await this.sendUserRecord(record);
    }

    return { id, isNew, unchanged };
  }

  // `follow`, when given, is a partial webhook-reported update to one or both follow
  // directions (see webhook.ts's follow.follow/follow.unfollow/follow.followed/
  // follow.unfollowed handling). It is also what forces the R2 copy out even when every profile
  // field is unchanged.
  async upsertXWebhookUser(
    user: XUserData,
    channelId: string,
    channelType: string,
    follow?: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<string> {
    console.log(JSON.stringify({ event: "x_user_raw", user_id: user.id, payload: user }));

    // The webhook payload is a bare user object, so the same metadata mappings the poller uses
    // resolve it — including verified_type, a real column in both stores (and the reason task 6
    // ships operation/migrations/0006-user-verified-type.ts: older tenant DBs lack the column).
    const resolved = resolveProps(user as Record<string, unknown>, X_USER_MAPPINGS, X_USER_META?.linkPrefix);
    const columnValues: Record<string, unknown> = {};
    for (const col of USER_VALUE_COLUMNS) {
      const val = resolved[col];
      if (val !== undefined && val !== null && val !== "") columnValues[col] = val;
    }

    const followValues: { is_follow?: 0 | 1; is_followed?: 0 | 1 } = {};
    if (follow?.is_follow !== undefined) followValues.is_follow = follow.is_follow;
    if (follow?.is_followed !== undefined) followValues.is_followed = follow.is_followed;

    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // Strip by dataId path (consumedPaths), never by propId: propId ≠ payload field name
    // (followers_count ← public_metrics.followers_count) — matching propId names against
    // top-level keys stripped nothing at all, which is how this repo got burned before.
    const paths = consumedPaths(X_USER_MAPPINGS, X_USER_META?.linkPrefix, MAPPED_USER_PROP_IDS);
    const rawData = JSON.stringify(stripConsumedPaths(user as Record<string, unknown>, paths));

    const { id } = await this.persistUser({
      channelId,
      channelType,
      sourceUserId: user.id,
      columnValues,
      followValues,
      rawData,
      forceSend: follow !== undefined,
    });
    return id;
  }

  // `resolvedProps` arrives already resolved by the caller (e.g. x-followers.ts's poller, which
  // walks its own metadata entry's userProps itself) — this method does not re-derive it, only
  // uses the caller-supplied `meta` to compute which payload paths were consumed, for raw_data
  // stripping.
  async upsertUserFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: string,
    // 调用方持有的 metadata 条目。只用于算 consumedPaths（raw_data 剥离），
    // resolvedProps 已经由调用方自己 resolveProps 好了。必填而非默认 X ——
    // 传错平台的 metadata 会把该留的字段剥掉、该剥的留下，两种都是静默的数据损坏。
    meta: UserMetadata
  ): Promise<boolean> {
    const sourceUserId = String(resolvedProps.source_user_id ?? rawItem.id ?? "");
    if (!sourceUserId) throw new Error("upsertUserFromMetadata: missing source_user_id");

    const columnValues: Record<string, unknown> = {};
    for (const col of USER_VALUE_COLUMNS) {
      const val = resolvedProps[col];
      if (val !== undefined && val !== null && val !== "") columnValues[col] = val;
    }

    // own:get-followers always resolves is_followed through its fixed `{value: 1}` mapping;
    // is_follow only appears if some future source resolves it. Both go into D1 AND through
    // persistUser -> mirrorFollowState into entity_state, in this same call.
    const followValues: { is_follow?: 0 | 1; is_followed?: 0 | 1 } = {};
    if (resolvedProps.is_follow !== undefined) followValues.is_follow = resolvedProps.is_follow as 0 | 1;
    if (resolvedProps.is_followed !== undefined) followValues.is_followed = resolvedProps.is_followed as 0 | 1;

    const paths = consumedPaths(meta.userProps, meta.linkPrefix, MAPPED_USER_PROP_IDS);
    const rawData = JSON.stringify(stripConsumedPaths(rawItem, paths));

    const { isNew } = await this.persistUser({
      channelId,
      channelType,
      sourceUserId,
      columnValues,
      followValues,
      rawData,
      // The poller reports the same fixed is_followed on every tick, so it is not a "change" by
      // itself — only a real diff against D1 (which the follow columns take part in) sends.
      forceSend: false,
    });
    return isNew;
  }

  // 只改 follow 位，不碰任何资料列。取消订阅/取关时用：调用方已经确认这个
  // (channelId, sourceUserId) 在 D1 里存在（它就是从 D1 查出来的），所以这里
  // 不再重复探测。forceSend: true 是必须的 —— follow 位变了但资料列一个字没动时，
  // persistUser 的 unchanged 比对虽然会因 follow 列而判定为「变了」，但 R2 无列级
  // 更新，只有推一条完整新行分析侧才看得到。
  async setFollowState(
    channelId: string,
    channelType: string,
    sourceUserId: string,
    follow: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<void> {
    await this.persistUser({
      channelId,
      channelType,
      sourceUserId,
      columnValues: {},
      followValues: follow,
      // json_patch(user.raw_data, '{}') 是无操作合并：这条写入不带任何新的原始字段。
      rawData: "{}",
      forceSend: true,
    });
  }

  // `eventProps` must arrive already resolved: the metadata `dataId` paths that describe
  // an event's props (e.g. `{linkPrefix}.public_metrics.followers_count`) can only be
  // walked by the caller, which is what holds the raw webhook payload and its linkPrefix.
  // `consumedPaths`, when supplied, lets raw_data strip exactly the payload paths
  // eventProps consumed (mirrors upsertContentFromMetadata's consumedPaths param) instead
  // of storing the full external payload. webhook.ts's call sites don't supply it yet
  // (Task 7 scope) — omitting it is loud (console.warn once per call) rather than silently
  // over-storing.
  //
  // R2-only, deliberately: `event` has no D1 table (the 2026-07-26 restore brought back only
  // `user` and `content`), so unlike the two upserts above there is no truth to write first.
  async insertEvents(
    events: Array<{
      userId: string; channelId: string; eventType: string; eventTime?: string;
      rawData?: unknown; eventProps?: Record<string, unknown>; consumedPaths?: string[];
    }>
  ): Promise<void> {
    if (!this.pipelineEvent || !this.tenantId) {
      // The old D1 insert was unconditional — a mid-rollout tenant (pipeline/tenantId not
      // wired yet) now silently loses every event instead. Loud, so it's visible (task-5 fix
      // round, Minor 2).
      if (events.length > 0) {
        console.warn(JSON.stringify({
          event: "insertEvents_no_pipeline",
          message: "PIPELINE_EVENT/tenantId not configured — events dropped",
          count: events.length,
        }));
      }
      return;
    }
    const now = new Date().toISOString();

    const records = events.map((e) => {
      const rawObj = e.rawData && typeof e.rawData === "object" ? (e.rawData as Record<string, unknown>) : {};
      let rawData: string;
      // An empty array strips nothing — same net effect as omitting the param entirely (the
      // whole payload lands in raw_data), so it must warn the same way. `[]` is truthy, so a
      // bare `if (e.consumedPaths)` silently swallowed this case (fix round 1, Minor 1) —
      // check length, not presence.
      if (e.consumedPaths && e.consumedPaths.length > 0) {
        rawData = JSON.stringify(stripConsumedPaths(rawObj, e.consumedPaths));
      } else {
        console.warn(JSON.stringify({
          event: "insertEvents_raw_data_unfiltered",
          message: "consumedPaths not provided (or empty) — storing the entire payload in raw_data",
          eventType: e.eventType,
        }));
        rawData = JSON.stringify(rawObj);
      }
      return this.buildEventRecord(
        { id: crypto.randomUUID(), userId: e.userId, channelId: e.channelId, eventType: e.eventType, eventTime: e.eventTime || now, rawData, createdAt: now },
        e.eventProps || {}
      );
    });

    await this.pipelineEvent.send(records).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_event_error", error: String(err) }));
    });
  }
}
