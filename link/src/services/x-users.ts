import type { Pipeline } from "../types";
import type { R2SqlEnv } from "../../../shared/r2-sql";
import { EntityStateStore, fingerprintOf, type EntityStateKey } from "./entity-state";
import { resolveProps, consumedPaths } from "./pollers/resolve-props";
import { getUserBySource } from "./r2-entities";
import { UserMetadata_X } from "../../../metadata/x-byok";

// X nests the counts under public_metrics and names some fields differently from our
// propIds (post_count -> tweet_count), so the propId -> payload path mapping has to come
// from metadata, never from the propId itself. `value`-only mappings are excluded: they
// describe a poller's fixed context (own:get-followers implies is_followed = 1) and must
// not be asserted for a user arriving through some other path.
const X_USER_META = UserMetadata_X.find((m) => m.sourceUserType === "own:get-followers");
const X_USER_MAPPINGS = (X_USER_META?.userProps || []).filter((m) => m.dataId);

// Full set of the R2 `user` table's value columns, i.e. everything except the key/audit
// columns every write builds explicitly (tenant_id, id, channel_id, channel_type,
// source_user_id, is_active, is_follow, is_followed, raw_data, is_deleted, created_at,
// updated_at). profile_image_url and description are real X user fields but have no R2
// column — they only ever land in raw_data. Keep in sync with
// analytics/pipelines/user-stream-schema.json.
//
// This is ALSO the one shared fingerprint field list for both upsertUser and
// upsertUserFromMetadata (task-5 fix round, Important 2). The two writers know different
// subsets of it (the webhook knows name/username; the poller knows all nine), so if each
// fingerprinted its own subset the two fingerprints would never agree — every poll tick and
// every webhook touch would look "changed" to the other and resend into the append-only
// sink forever. Fingerprinting the same field list, over the MERGED row for an existing
// user (see upsertUser's read-modify-write), is what makes them agree.
const R2_USER_VALUE_COLUMNS = [
  "name", "username", "verified_type",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
];

// propIds that land in a named R2 column — source_user_id (the entity key itself) plus every
// R2_USER_VALUE_COLUMNS entry. Used to filter consumedPaths() so a mapped-but-columnless prop
// (profile_image_url, description — real X_USER_MAPPINGS entries with no R2 column) is never
// treated as "consumed" and stripped out of raw_data, which would destroy it with nowhere else
// to land (task-5 fix round, Important 1).
const MAPPED_USER_PROP_IDS = new Set<string>(["source_user_id", ...R2_USER_VALUE_COLUMNS]);

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

export class XUsersService {
  private pipelineEvent?: Pipeline;
  private pipelineUser?: Pipeline;
  private tenantId?: number;

  constructor(
    private entityState: EntityStateStore,
    opts?: { pipelineEvent?: Pipeline; pipelineUser?: Pipeline; tenantId?: number },
    private r2Env?: R2SqlEnv
  ) {
    this.pipelineEvent = opts?.pipelineEvent;
    this.pipelineUser = opts?.pipelineUser;
    this.tenantId = opts?.tenantId;
  }

  // Builds a complete R2 `user` row: every value column present, explicit null when
  // unknown. `values` only needs to carry the columns this call site actually knows —
  // everything else in R2_USER_VALUE_COLUMNS is filled in as null.
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
    for (const col of R2_USER_VALUE_COLUMNS) {
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

  private async sendUserRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.pipelineUser) return;
    await this.pipelineUser.send([record]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_user_error", userId: record.id, error: String(err) }));
    });
  }

  // Only used by upsertUserFromMetadata, which never reads entity_state up front (unlike
  // upsertUser, see below) — so it still needs its own conditional read here. A freshly
  // claimed key (isNew) has nothing stored yet, so there is no point reading it — skip the
  // D1 round-trip and default straight to 0.
  private async resolveFollow(
    key: EntityStateKey,
    isNew: boolean,
    explicit: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<{ isFollow: 0 | 1; isFollowed: 0 | 1 }> {
    const needsStored = !isNew && (explicit.is_follow === undefined || explicit.is_followed === undefined);
    const stored = needsStored ? await this.entityState.get(key) : null;
    return {
      isFollow: (explicit.is_follow ?? stored?.is_follow ?? 0) as 0 | 1,
      isFollowed: (explicit.is_followed ?? stored?.is_followed ?? 0) as 0 | 1,
    };
  }

  // `follow`, when given, is a partial webhook-reported update to one or both follow
  // directions (see webhook.ts's follow.follow/follow.unfollow/follow.followed/
  // follow.unfollowed handling) — the fix for the bug this task exists to close: this used
  // to hardcode is_follow/is_followed to 0 in the R2 record no matter what, so the Users
  // list (which reads those two R2 columns) showed "not following" for everyone.
  async upsertUser(
    user: XUserData,
    channelId: string,
    channelType: string,
    follow?: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<string> {
    console.log(JSON.stringify({ event: "x_user_raw", user_id: user.id, payload: user }));
    const now = new Date().toISOString();
    const key: EntityStateKey = { entity: "user", channelId, sourceId: user.id };

    // A single upfront read answers both "does this user already exist" (for read-modify-write
    // below, Important 2) and "what follow state is currently stored" (Critical 1) — claim()
    // itself can't safely answer the first question: it commits whatever fingerprint it's
    // given, so probing existence by calling it with a not-yet-merged fingerprint would
    // corrupt the stored fingerprint before there's a chance to compute the correct one (see
    // upsertUserFromMetadata's fingerprint, which this MUST end up agreeing with).
    const existingState = await this.entityState.get(key);
    const isNew = existingState === null;

    const resolved = resolveProps(user as Record<string, unknown>, X_USER_MAPPINGS, X_USER_META?.linkPrefix);
    const webhookValues: Record<string, unknown> = {};
    for (const col of R2_USER_VALUE_COLUMNS) {
      if (col in resolved) webhookValues[col] = resolved[col];
    }

    // A pipeline write is the only thing that can null out a column, so read-modify-write (and
    // its r2Env requirement) only matters when a write is actually about to happen (task-5 fix
    // round 2, Important). A tenant with no pipeline configured yet — or one configured without
    // r2Env — still needs claim()/setFollow() below to run unconditionally: entity_state.
    // is_follow/is_followed is what the workflow engine reads on every action and must never
    // stop being maintained, mid-rollout or not. So a missing r2Env is remembered here and
    // thrown only AFTER claim()/setFollow() run, never before.
    const willWriteToR2 = Boolean(this.pipelineUser && this.tenantId);
    const r2Env = this.r2Env;
    const tenantId = this.tenantId;

    let mergedValues = webhookValues;
    let missingR2EnvForMerge = false;
    if (willWriteToR2 && !isNew) {
      if (!r2Env) {
        // Deferred — see the comment above. A pipeline write without this merge would null
        // out every metric column the poller last populated, the exact damage Important 2
        // exists to prevent, so this is a real misconfiguration and must still fail loudly.
        missingR2EnvForMerge = true;
      } else {
        // No R2 read for a brand-new user (isNew above), and none at all when no pipeline is
        // configured — only an existing user with an active pipeline pays this cost, never
        // the poller's per-tick, hundreds-of-followers loop (that's upsertUserFromMetadata,
        // which never reads R2 — see its comment).
        const priorRow = await getUserBySource(r2Env, tenantId!, channelId, user.id);
        if (priorRow) {
          const priorValues: Record<string, unknown> = {};
          for (const col of R2_USER_VALUE_COLUMNS) priorValues[col] = priorRow[col];
          mergedValues = { ...priorValues, ...webhookValues };
        }
      }
    }

    // Fingerprint over the exact same field list upsertUserFromMetadata uses
    // (R2_USER_VALUE_COLUMNS), computed over the MERGED row when a merge happened — this is
    // what lets the two writers' fingerprints agree when nothing has actually changed
    // (Important 2).
    const fingerprint = await fingerprintOf(mergedValues, R2_USER_VALUE_COLUMNS);
    const { entityId, unchanged } = await this.entityState.claim(key, fingerprint);

    // Written unconditionally — even ahead of the throw below — so a misconfigured or
    // not-yet-fully-wired tenant still gets correct flow-trigger behavior; flow reads
    // entity_state, never R2, for this.
    if (follow?.is_follow !== undefined) await this.entityState.setFollow(key, "is_follow", follow.is_follow);
    if (follow?.is_followed !== undefined) await this.entityState.setFollow(key, "is_followed", follow.is_followed);

    if (missingR2EnvForMerge) {
      throw new Error(
        "XUsersService.upsertUser: existing user with a pipeline configured requires r2Env to merge the R2 row — without it, this write would null out every column the poller last populated"
      );
    }

    // A follow-state change must still produce an R2 row even if name/username/avatar are
    // byte-identical to the last snapshot — R2 has no column-wise update, so the D1 write
    // above would be invisible to R2 readers (Users list) otherwise.
    const changedFollow = follow !== undefined;
    if (unchanged && !changedFollow) return entityId;
    if (!willWriteToR2) return entityId;

    // existingState already carries the currently-stored follow bits (fetched above) — no
    // extra D1 round trip needed here, unlike upsertUserFromMetadata's resolveFollow.
    const isFollow = (follow?.is_follow ?? existingState?.is_follow ?? 0) as 0 | 1;
    const isFollowed = (follow?.is_followed ?? existingState?.is_followed ?? 0) as 0 | 1;

    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // Strip by dataId path (consumedPaths), never by propId: propId ≠ payload field name
    // (followers_count ← public_metrics.followers_count) — matching propId names against
    // top-level keys stripped nothing at all, which is how this repo got burned before.
    // MAPPED_USER_PROP_IDS additionally excludes profile_image_url/description — they have a
    // dataId but no R2 column, so treating them as "consumed" would destroy them (Important 1).
    const paths = consumedPaths(X_USER_MAPPINGS, X_USER_META?.linkPrefix, MAPPED_USER_PROP_IDS);
    const rawData = JSON.stringify(stripConsumedPaths(user as Record<string, unknown>, paths));

    const record = this.buildUserRecord(
      { id: entityId, channelId, channelType, sourceUserId: user.id, isFollow, isFollowed, rawData, createdAt: now, updatedAt: now },
      mergedValues
    );
    await this.sendUserRecord(record);
    return entityId;
  }

  // `resolvedProps` arrives already resolved by the caller (e.g. x-followers.ts's poller,
  // which walks FOLLOWERS_METADATA.userProps itself) — this method does not re-derive it,
  // only uses its own X_USER_MAPPINGS/X_USER_META (the same metadata entry) to compute
  // which payload paths were consumed, for raw_data stripping.
  //
  // No R2 read here, ever — unlike upsertUser, this path already knows every value column it
  // can know (own:get-followers resolves name/username/profile_image_url/all counts in one
  // page fetch), so there is nothing to merge in, and the poller walks pages of hundreds of
  // followers per tick — a 1-3s R2 query per follower would be catastrophic (task-5 fix round,
  // Important 2's critical constraint).
  async upsertUserFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: string
  ): Promise<boolean> {
    const sourceUserId = String(resolvedProps.source_user_id ?? rawItem.id ?? "");
    if (!sourceUserId) throw new Error("upsertUserFromMetadata: missing source_user_id");

    const now = new Date().toISOString();
    const key: EntityStateKey = { entity: "user", channelId, sourceId: sourceUserId };

    // 指纹覆盖 R2_USER_VALUE_COLUMNS —— 与 upsertUser 共用同一份字段清单(Important 2),
    // 否则两个 writer 的指纹永远对不上,poller 每 tick / webhook 每次 touch 都会被对方判定
    // 为「变了」,把没变的行也重发进 append-only 的 R2。created_at/updated_at 不参与,否则
    // 每次都判定为「变了」。Poller re-walks pages of already-known followers on every tick
    // (see x-followers.ts runIncrementalPoll) — without the fingerprint check, every visit
    // resends an unchanged user to the R2 pipeline, which has no dedup on write.
    const trackedValues: Record<string, unknown> = {};
    for (const col of R2_USER_VALUE_COLUMNS) {
      if (col in resolvedProps) trackedValues[col] = resolvedProps[col];
    }
    const fingerprint = await fingerprintOf(trackedValues, R2_USER_VALUE_COLUMNS);
    const { entityId: id, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

    // Mirror any known follow bit into entity_state immediately (task-5 fix round, Critical
    // 1): own:get-followers always resolves is_followed via its fixed `{value:1}` mapping.
    // Without this write, entity_state.is_followed stayed NULL forever for a
    // poller-discovered follower — the next webhook touch (upsertUser, no follow arg) read
    // that NULL back as 0 and overwrote a correct R2 is_followed=1 with 0, reintroducing the
    // exact bug this task exists to close. Written unconditionally (before the
    // unchanged/pipeline early-return below), matching upsertUser's ordering — D1 is the flow
    // engine's hot-read path regardless of whether an R2 pipeline is configured here.
    const explicitIsFollow = resolvedProps.is_follow as 0 | 1 | undefined;
    const explicitIsFollowed = resolvedProps.is_followed as 0 | 1 | undefined;
    if (explicitIsFollow !== undefined) await this.entityState.setFollow(key, "is_follow", explicitIsFollow);
    if (explicitIsFollowed !== undefined) await this.entityState.setFollow(key, "is_followed", explicitIsFollowed);

    if (!this.pipelineUser || !this.tenantId || unchanged) return isNew;

    const { isFollow, isFollowed } = await this.resolveFollow(key, isNew, { is_follow: explicitIsFollow, is_followed: explicitIsFollowed });

    const paths = consumedPaths(X_USER_MAPPINGS, X_USER_META?.linkPrefix, MAPPED_USER_PROP_IDS);
    const rawData = JSON.stringify(stripConsumedPaths(rawItem, paths));

    const record = this.buildUserRecord(
      { id, channelId, channelType, sourceUserId, isFollow, isFollowed, rawData, createdAt: now, updatedAt: now },
      trackedValues
    );
    await this.sendUserRecord(record);

    return isNew;
  }

  // `eventProps` must arrive already resolved: the metadata `dataId` paths that describe
  // an event's props (e.g. `{linkPrefix}.public_metrics.followers_count`) can only be
  // walked by the caller, which is what holds the raw webhook payload and its linkPrefix.
  // `consumedPaths`, when supplied, lets raw_data strip exactly the payload paths
  // eventProps consumed (mirrors upsertContentFromMetadata's consumedPaths param) instead
  // of storing the full external payload. webhook.ts's call sites don't supply it yet
  // (Task 7 scope, per the task-5 brief's scope boundary) — omitting it is loud
  // (console.warn once per call) rather than silently over-storing.
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
