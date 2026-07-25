import type { Pipeline } from "../types";
import { EntityStateStore, fingerprintOf, type EntityStateKey } from "./entity-state";
import { resolveProps, consumedPaths } from "./pollers/resolve-props";
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
const R2_USER_VALUE_COLUMNS = [
  "name", "username", "verified_type",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
];

// Business-field subset used for entity_state change detection in upsertUserFromMetadata.
// A superset of R2_USER_VALUE_COLUMNS: profile_image_url/description have no R2 column but
// still land in raw_data, so a change to either is still a real change worth resending.
// created_at/updated_at deliberately excluded, or every poll would look "changed".
const USER_FINGERPRINT_FIELDS = [...R2_USER_VALUE_COLUMNS, "profile_image_url", "description"];

// R2 event pipeline's value columns beyond the fixed identity/time columns every write
// builds explicitly. Keep in sync with analytics/pipelines/event-stream-schema.json.
const EVENT_VALUE_COLUMNS = ["followers_count", "following_count", "verified_type", "message_text"];

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

// Fields the legacy bulk upsertUsers() still snapshots into raw_data. It never resolves
// metadata props (no channel/linkPrefix context — see upsertUsers's comment), so it keeps
// its own small curated field list rather than the consumedPaths machinery.
const DB_FIELDS = ["id", "name", "username", "profile_image_url", "description", "location", "url", "verified", "verified_type", "protected", "created_at", "public_metrics"] as const;

function pickDbFields(user: XUserData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of DB_FIELDS) {
    const val = user[key];
    if (val !== null && val !== undefined && val !== "") {
      result[key] = val;
    }
  }
  return result;
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
  private queue?: Queue;
  private pipelineEvent?: Pipeline;
  private pipelineUser?: Pipeline;
  private tenantId?: number;

  constructor(
    private entityState: EntityStateStore,
    opts?: { queue?: Queue; pipelineEvent?: Pipeline; pipelineUser?: Pipeline; tenantId?: number }
  ) {
    this.queue = opts?.queue;
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

  // Both is_follow and is_followed are ALSO stored in D1 entity_state (flow's hot-read
  // path — a 1-3s R2 query per node evaluation is not affordable) by the setFollow calls
  // at each call site; this only decides what value the R2 row's two columns get. A
  // freshly claimed key (isNew) has nothing stored yet, so there is no point reading it —
  // skip the D1 round-trip and default straight to 0. An existing key that leaves either
  // bit unspecified must read the stored value back, or e.g. a follow.follow webhook
  // (which only ever tells us is_follow) would silently reset is_followed to 0 on every
  // R2 write, even though nothing about "do they follow us" changed.
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

    const tracked = { name: user.name, username: user.username, profile_image_url: user.profile_image_url };
    const fingerprint = await fingerprintOf(tracked, ["name", "username", "profile_image_url"]);
    const { entityId, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

    // Written unconditionally (even when the R2 pipeline below ends up skipped) so a
    // tenant with no pipeline configured still gets correct flow-trigger behavior — flow
    // reads entity_state, never R2, for this.
    if (follow?.is_follow !== undefined) await this.entityState.setFollow(key, "is_follow", follow.is_follow);
    if (follow?.is_followed !== undefined) await this.entityState.setFollow(key, "is_followed", follow.is_followed);

    // A follow-state change must still produce an R2 row even if name/username/avatar are
    // byte-identical to the last snapshot — R2 has no column-wise update, so the D1 write
    // above would be invisible to R2 readers (Users list) otherwise.
    const changedFollow = follow !== undefined;
    if (unchanged && !changedFollow) return entityId;
    if (!this.pipelineUser || !this.tenantId) return entityId;

    const { isFollow, isFollowed } = await this.resolveFollow(key, isNew, follow ?? {});

    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // Strip by dataId path (consumedPaths), never by propId: propId ≠ payload field name
    // (followers_count ← public_metrics.followers_count) — matching propId names against
    // top-level keys stripped nothing at all, which is how this repo got burned before.
    const paths = consumedPaths(X_USER_MAPPINGS, X_USER_META?.linkPrefix);
    const rawData = JSON.stringify(stripConsumedPaths(user as Record<string, unknown>, paths));

    const resolved = resolveProps(user as Record<string, unknown>, X_USER_MAPPINGS, X_USER_META?.linkPrefix);
    const values: Record<string, unknown> = {};
    for (const col of R2_USER_VALUE_COLUMNS) {
      if (col in resolved) values[col] = resolved[col];
    }

    const record = this.buildUserRecord(
      { id: entityId, channelId, channelType, sourceUserId: user.id, isFollow, isFollowed, rawData, createdAt: now, updatedAt: now },
      values
    );
    await this.sendUserRecord(record);
    return entityId;
  }

  // `resolvedProps` arrives already resolved by the caller (e.g. x-followers.ts's poller,
  // which walks FOLLOWERS_METADATA.userProps itself) — this method does not re-derive it,
  // only uses its own X_USER_MAPPINGS/X_USER_META (the same metadata entry) to compute
  // which payload paths were consumed, for raw_data stripping.
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

    // 指纹只覆盖会变的业务字段;created_at/updated_at 不参与,否则每次都判定为「变了」。
    // Poller re-walks pages of already-known followers on every tick (see x-followers.ts
    // runIncrementalPoll) — without this check, every visit resends an unchanged user to
    // the R2 pipeline, which has no dedup on write (append-only Iceberg sink).
    const trackedValues: Record<string, unknown> = {};
    for (const col of USER_FINGERPRINT_FIELDS) {
      if (col in resolvedProps) trackedValues[col] = resolvedProps[col];
    }
    const fingerprint = await fingerprintOf(trackedValues, USER_FINGERPRINT_FIELDS);
    const { entityId: id, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

    if (!this.pipelineUser || !this.tenantId || unchanged) return isNew;

    // own:get-followers maps is_followed via a fixed `{ value: 1 }` (not a dataId), so it
    // arrives as a plain resolved prop; is_follow is never known from this path (a
    // followers-list page tells us nothing about whether we follow them back) — resolved
    // from stored entity_state instead, same as upsertUser.
    const explicitIsFollowed = resolvedProps.is_followed as 0 | 1 | undefined;
    const { isFollow, isFollowed } = await this.resolveFollow(key, isNew, { is_followed: explicitIsFollowed });

    const paths = consumedPaths(X_USER_MAPPINGS, X_USER_META?.linkPrefix);
    const rawData = JSON.stringify(stripConsumedPaths(rawItem, paths));

    const record = this.buildUserRecord(
      { id, channelId, channelType, sourceUserId, isFollow, isFollowed, rawData, createdAt: now, updatedAt: now },
      trackedValues
    );
    await this.sendUserRecord(record);

    return isNew;
  }

  // Legacy bulk path with no live caller today (grep confirms) and, unlike upsertUser/
  // upsertUserFromMetadata, no channel context at all — it predates per-channel scoping.
  // Kept working rather than deleted (少改动) by scoping its entity_state key on an empty
  // channelId, which still gives it a stable per-tenant business key.
  async upsertUsers(users: XUserData[]): Promise<void> {
    if (users.length > 0) {
      console.log(JSON.stringify({ event: "x_user_raw", sample: true, user_id: users[0].id, payload: users[0] }));
    }

    const now = new Date().toISOString();
    const newUserIds = new Set<string>();

    for (const user of users) {
      const key: EntityStateKey = { entity: "user", channelId: "", sourceId: user.id };
      const tracked = { name: user.name, username: user.username, profile_image_url: user.profile_image_url };
      const fingerprint = await fingerprintOf(tracked, ["name", "username", "profile_image_url"]);
      const { entityId, isNew, unchanged } = await this.entityState.claim(key, fingerprint);
      if (isNew) newUserIds.add(user.id);

      if (this.pipelineUser && this.tenantId && !unchanged) {
        const record = this.buildUserRecord(
          {
            id: entityId, channelId: "", channelType: "", sourceUserId: user.id,
            isFollow: 0, isFollowed: 0,
            rawData: JSON.stringify(pickDbFields(user)),
            createdAt: now, updatedAt: now,
          },
          { name: user.name ?? null, username: user.username ?? null }
        );
        await this.sendUserRecord(record);
      }
    }

    if (this.queue && newUserIds.size > 0) {
      const messages = users
        .filter((u) => newUserIds.has(u.id) && u.username)
        .map((u) => ({ body: { user_id: u.id, username: u.username } }));
      if (messages.length > 0) {
        await this.queue.sendBatch(messages);
      }
    }
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
    if (!this.pipelineEvent || !this.tenantId) return;
    const now = new Date().toISOString();

    const records = events.map((e) => {
      const rawObj = e.rawData && typeof e.rawData === "object" ? (e.rawData as Record<string, unknown>) : {};
      let rawData: string;
      if (e.consumedPaths) {
        rawData = JSON.stringify(stripConsumedPaths(rawObj, e.consumedPaths));
      } else {
        console.warn(JSON.stringify({
          event: "insertEvents_raw_data_unfiltered",
          message: "consumedPaths not provided — storing the entire payload in raw_data",
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
