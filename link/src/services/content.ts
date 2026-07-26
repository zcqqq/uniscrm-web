import type { TenantDataDB } from "../../../shared/tenant-data-db";
import type { ContentRow, ChannelType, Pipeline } from "../types";
import type { ChannelItem } from "../channels/interface";
import type { EntityStateStore } from "./entity-state";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// propId -> column name. The name is shared by BOTH stores on purpose: per-tenant D1 is the
// source of truth (2026-07-26 plan: user/content back to per-tenant D1) and the R2 Iceberg
// `content` table is an analytics-only copy of the same row, so one map drives both writes.
// The D1 schema (admin/src/services/tenant-init-sql.ts) is a superset of the R2 schema — every
// column named here exists in both. A resolved prop not in this map only ever lives in
// raw_data. `list_id` deliberately does not go through this map: it's a dedup-key component the
// caller passes separately, not a value resolved from metadata props.
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  view_count: "view_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
  share_count: "share_count",
  cover_image_url: "cover_image_url",
  duration: "duration",
  height: "height",
  width: "width",
  has_face: "has_face",
  // `content_url` is the propId every caller (x-posts.ts/webhook.ts's manual permalink,
  // tiktok.ts's metadata-mapped share_url) already uses; `source_url` is the column it
  // belongs in — the Content Library page renders the title as a link via item.source_url.
  // Missing until task-7 fix round 1 (Minor 3): content_url reached neither a column nor
  // raw_data (it's a value resolveProps computed, not consumed from the payload, so
  // consumedPaths never targeted it either) — every X/TikTok/YouTube row lost its link.
  content_url: "source_url",
};

// The columns upsertContentFromMetadata probes off the existing D1 row to decide whether
// anything actually changed. This replaces the entity_state fingerprint the R2-as-truth phase
// used: D1 holds the previous values, so a plain column compare is both cheaper (no hashing)
// and exact. created_at/updated_at are deliberately excluded, or every call would look "changed".
const CONTENT_TABLE_COLUMNS = Object.values(CONTENT_COLUMN_MAP);

// propIds from CONTENT_COLUMN_MAP's keys, plus source_content_id — every propId that actually
// lands in a named column. Exported so a caller computing consumedPaths
// (pollers/resolve-props.ts) before calling upsertContentFromMetadata can pass this as
// consumedPaths' `allowedPropIds` filter, so a metadata prop that has a dataId but no
// CONTENT_COLUMN_MAP entry doesn't get treated as "consumed" and stripped out of raw_data with
// nowhere else to land — the same bug class the task-5 fix round caught on the user path
// (profile_image_url/description had a dataId but no `user` column, and were being
// destroyed). `source_content_id` isn't a CONTENT_COLUMN_MAP entry (it's the entity key, passed
// separately by the caller — see upsertContentFromMetadata below) but it IS a real column, so
// it belongs here too — mirrors x-users.ts's MAPPED_USER_PROP_IDS, which explicitly includes
// `source_user_id` for the identical reason. Omitting it here (task 7's original cut) meant
// `{linkPrefix}.id` was never stripped and every X/TikTok tweet or video id ended up duplicated
// into raw_data despite already having a named column (task-7 fix round 1, Minor 2).
export const CONTENT_MAPPED_PROP_IDS = new Set(["source_content_id", ...Object.keys(CONTENT_COLUMN_MAP)]);

// Full set of the R2 `content` table's value columns, i.e. everything except the
// key/audit columns every write builds explicitly (tenant_id, id, channel_id, channel_type,
// source_content_id, list_id, raw_data, is_deleted, created_at, updated_at). This is a
// superset of CONTENT_COLUMN_MAP's values: some columns here (summary, source_url,
// source_updated_at, impression_count) aren't resolvable from metadata props and are only
// ever populated by other write paths (e.g. syncBatch), but every write must still send them
// explicitly as null — reads take one whole row via QUALIFY ROW_NUMBER() = 1, so a write that
// omits a column here silently nulls it out. Keep in sync with
// analytics/pipelines/content-stream-schema.json.
const R2_CONTENT_VALUE_COLUMNS = [
  "content_type", "content_text", "title", "summary",
  "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "impression_count", "view_count", "like_count",
  "quote_count", "reply_count", "repost_count", "share_count",
];

// Read projection that turns a D1 `content` row into the exact ContentRow shape the routes and
// the frontend already consume. Two of ContentRow's fields are not D1 columns and are projected
// as constants:
//   - impression_count: an R2-only analytics column that no writer anywhere populates (verified
//     column-by-column in task 1's D1-superset review), so D1 has nothing to store for it.
//   - is_deleted: D1 deletes are physical (`DELETE FROM content`), so a row that comes back from
//     D1 is by definition not deleted. The flag exists only in the R2 copy, whose append-only
//     Iceberg sink has no DELETE and needs a tombstone instead.
const CONTENT_READ_PROJECTION = [
  "id", "channel_id", "channel_type", "content_type", "source_content_id", "list_id",
  "title", "content_text", "summary", "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "NULL AS impression_count", "view_count", "like_count", "quote_count",
  "reply_count", "repost_count", "share_count",
  "raw_data", "created_at", "updated_at", "0 AS is_deleted",
].join(", ");

// The business fields syncBatch's ChannelItem carries, compared column-by-column against the
// existing D1 row to decide added/updated/skipped.
const SYNC_COMPARE_COLUMNS = ["source_updated_at", "title", "summary", "source_url"] as const;

// Deep-clones `payload` and deletes each dotted `path` (e.g. "public_metrics.impression_count")
// from it — the complement of what resolveProps consumed, per consumedPaths in
// pollers/resolve-props.ts. Tolerates a path that doesn't exist (nothing to delete). Leaves a
// parent object in place even if removing its last child empties it — this strips consumed
// leaves, it doesn't reshape the payload.
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

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

// Vectorize embedding only ever reads these four fields (see buildEmbeddingText below) — it
// never needed a full ContentRow. Every embedding call site used to build a fake full ContentRow
// just to satisfy the old signature, silently omitting columns that TypeScript's excess-property
// check on `status` (removed — the column no longer exists) had been masking: once an object
// literal has one excess property, TS skips reporting *missing* ones for that same literal, so
// those omissions were never actually caught by the compiler. Narrowing the type to exactly what
// embedding uses fixes both problems at once instead of padding three call sites with 15 fake
// nulls apiece.
type EmbeddingInput = Pick<ContentRow, "id" | "title" | "content_text" | "summary">;

export class ContentService {
  private namespace: string;

  constructor(
    // Per-tenant D1 — the source of truth. Nullable because a tenant's database may not be
    // provisioned yet (middleware only injects it when tenants.d1_database_id is set); every
    // method that needs it says so loudly through requireDb() rather than dying on
    // `undefined.query`.
    private tenantDb: TenantDataDB | null,
    private vectorize: VectorizeIndex,
    private ai: Ai,
    private tenantId: number,
    private pipelineContent?: Pipeline,
    private flowQueue?: Queue,
    // entity_state has shrunk to two jobs; the only one on the content path is trigger-content
    // dedup (recordTriggerContentSeen). No content row's identity comes from it any more — ids
    // are minted by D1.
    private entityState?: EntityStateStore
  ) {
    this.namespace = `tenant-${tenantId}`;
  }

  private requireDb(method: string): TenantDataDB {
    if (!this.tenantDb) {
      throw new Error(`ContentService.${method}: tenantDb is required (tenant DB not provisioned)`);
    }
    return this.tenantDb;
  }

  // Builds a complete R2 `content` row: every value column present, explicit null when
  // unknown. `values` only needs to carry the columns this call site actually knows —
  // everything else in R2_CONTENT_VALUE_COLUMNS is filled in as null.
  private buildContentRecord(
    base: {
      id: string;
      channelId: string | null;
      channelType: ChannelType;
      sourceContentId: string;
      listId?: string | null;
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
      channel_type: base.channelType,
      source_content_id: base.sourceContentId,
      list_id: base.listId ?? null,
      raw_data: base.rawData,
      is_deleted: base.isDeleted ?? 0,
      created_at: base.createdAt,
      updated_at: base.updatedAt,
    };
    for (const col of R2_CONTENT_VALUE_COLUMNS) {
      record[col] = values[col] ?? null;
    }
    return record;
  }

  // Fire-and-log. R2 is a copy, not the truth: by the time this runs the D1 write has already
  // committed, so a failed send must neither fail the caller nor roll anything back. That is a
  // deliberate, accepted downgrade — the analytics copy of this row stays stale until the next
  // REAL change to it (an unchanged poll pass sends nothing, by design), which is the price of
  // not letting an analytics-side outage break ingestion. The rollback-the-fingerprint dance the
  // R2-as-truth phase needed (sendContentRecordOrRollback) died with the fingerprints.
  private async sendContentRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.pipelineContent) return;
    await this.pipelineContent.send([record]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_content_error", contentId: record.id, error: String(err) }));
    });
  }

  // LOCAL/NOTION imports (syncBatch's only callers) are content by definition — a user
  // explicitly importing documents/pages into their own Content Library — so they persist with
  // no flowType gate. The gate on upsertContentFromMetadata exists because the metadata registry
  // mixes content/trigger/action sources behind one poller entry point; these channel adapters
  // have no such ambiguity and metadata/*.ts declares no flowType for them at all.
  async syncBatch(
    channelType: ChannelType,
    items: ChannelItem[]
  ): Promise<SyncResult> {
    const db = this.requireDb("syncBatch");
    const now = new Date().toISOString();

    const existing = await db.query<Record<string, unknown> & { id: string; source_content_id: string; channel_id: string | null; created_at: string }>(
      `SELECT id, source_content_id, channel_id, ${SYNC_COMPARE_COLUMNS.join(", ")}, created_at FROM content WHERE channel_type = ?`,
      [channelType]
    );
    const existingMap = new Map(existing.map((e) => [e.source_content_id, e]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: EmbeddingInput[] = [];

    for (const item of items) {
      const values: Record<string, unknown> = {
        source_updated_at: item.source_updated_at,
        title: item.title,
        summary: item.summary,
        source_url: item.source_url,
      };
      const ex = existingMap.get(item.source_content_id);

      // A row written before this migration has channel_id NULL (the old code never set it),
      // while its R2 copies go out under channel_id = channelType. Left alone it stays NULL
      // forever — the probe matches on channel_type, so the row IS found, and an unchanged item
      // would skip out before any UPDATE could heal it. deleting such a row later would then
      // build its tombstone from a NULL channel_id and R2 Pipelines would drop it (required
      // column), leaving the item visible in analytics permanently. So a channel_id that doesn't
      // match counts as "changed": the write below repairs it through the normal path.
      const needsChannelIdRepair = !!ex && ex.channel_id !== channelType;

      // 461d039 compared source_updated_at alone, which freezes a source that never publishes
      // that field (a plain LOCAL upload) at its first import forever. Comparing all four
      // business columns is the same D1-column-compare shape and happens to be exactly the field
      // set the R2-as-truth phase fingerprinted, so nothing regresses against either baseline.
      if (ex && !needsChannelIdRepair && SYNC_COMPARE_COLUMNS.every((c) => String(values[c] ?? "") === String(ex[c] ?? ""))) {
        skipped++;
        continue;
      }

      const rawData = JSON.stringify(item.raw_data || {});
      const id = ex ? ex.id : crypto.randomUUID();
      const createdAt = ex ? ex.created_at : now;

      // A channel-less import has no channel row, so `channel_type` doubles as `channel_id` —
      // honest rather than a workaround: for such an import the channel *type* IS the channel.
      // It also keeps the two stores identical on the business key. R2's `channel_id` is a
      // required column (Pipelines silently drops records with a null required field) and
      // delete() below builds its R2 tombstone straight out of the D1 row, so a NULL channel_id
      // in D1 would produce a tombstone R2 throws away. Finally it stops {LOCAL, id:"1"} and
      // {NOTION, id:"1"} from colliding on one (channel_id, list_id, source_content_id) key.
      if (ex) {
        // channel_id is in the SET list, not just the INSERT: see needsChannelIdRepair above.
        await db.run(
          "UPDATE content SET channel_id = ?, title = ?, summary = ?, source_url = ?, source_updated_at = ?, raw_data = ?, updated_at = ? WHERE id = ?",
          [channelType, item.title, item.summary, item.source_url, item.source_updated_at, rawData, now, id]
        );
        updated++;
      } else {
        await db.run(
          "INSERT INTO content (id, channel_id, channel_type, source_content_id, title, summary, source_url, source_updated_at, raw_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, channelType, channelType, item.source_content_id, item.title, item.summary, item.source_url, item.source_updated_at, rawData, createdAt, now]
        );
        added++;
      }

      needsEmbedding.push({
        id,
        title: item.title,
        content_text: null,
        summary: item.summary,
      });

      const record = this.buildContentRecord(
        { id, channelId: channelType, channelType, sourceContentId: item.source_content_id, listId: null, rawData, createdAt, updatedAt: now },
        values
      );
      await this.sendContentRecord(record);
    }

    await this.embedContents(needsEmbedding);
    return { added, updated, skipped };
  }

  async upsertContentFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: ChannelType,
    emitFlowEvent: boolean,
    listId?: string,
    // Exactly the rawItem paths resolveProps consumed (see pollers/resolve-props.ts's
    // consumedPaths) — i.e. the payload fields that landed in a named column. raw_data strips
    // THESE, never propIds: a propId is not a payload field name (view_count ← rawItem's
    // public_metrics.impression_count), so the old propId-keyed filter stripped nothing for X
    // content at all and shipped full tweet payloads downstream. Omitting this parameter is loud
    // (console.warn once) rather than silently over-storing.
    consumedPaths?: string[],
    // The `flowType` of the metadata entry this row came from (metadata/*.ts). Only
    // flowType:"content" sources are persisted; trigger sources go through
    // recordTriggerContentSeen + emitContentTriggerEvent instead, and action sources aren't
    // ingestion at all.
    flowType?: string
  ): Promise<boolean> {
    // Defense line, not the routing decision: callers branch on their own metadata entry's
    // flowType, and this refuses anything that still reaches here carrying a KNOWN non-content
    // value. `undefined` is allowed through for callers that have no metadata entry to read —
    // nothing declares an "unknown" flowType, so an absent one means the caller predates the
    // gate, not that it is a trigger. This must stay driven by the metadata VALUE: never branch
    // on a poller or channel name here, or a new source silently inherits the wrong verdict.
    if (flowType !== undefined && flowType !== "content") {
      throw new Error("upsertContentFromMetadata: refusing to persist non-content flowType: " + flowType);
    }

    const sourceContentId = String(resolvedProps.source_content_id ?? "");
    if (!sourceContentId) throw new Error("upsertContentFromMetadata: missing source_content_id");

    const db = this.requireDb("upsertContentFromMetadata");
    const now = new Date().toISOString();

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }
    const dynamicCols = Object.keys(columnValues);

    // The two partial unique indexes (admin/src/services/tenant-init-sql.ts) make list-scoped
    // and list-less rows two separate key spaces, so this probe has to match exactly the
    // semantics of the ON CONFLICT target chosen below.
    const existing = listId
      ? await db.query<Record<string, unknown> & { id: string; created_at: string }>(
          `SELECT id, created_at, ${CONTENT_TABLE_COLUMNS.join(", ")} FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id = ?`,
          [channelId, sourceContentId, listId]
        )
      : await db.query<Record<string, unknown> & { id: string; created_at: string }>(
          `SELECT id, created_at, ${CONTENT_TABLE_COLUMNS.join(", ")} FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id IS NULL`,
          [channelId, sourceContentId]
        );
    // The probe only PROPOSES an id: between it and the upsert another writer for the same
    // business key (webhook post.create vs. the poller's re-walk) can insert first, and the
    // upsert's DO UPDATE deliberately does not touch `id`, so D1 keeps the winner's. The
    // authoritative id therefore comes back from the write itself via RETURNING — see below.
    const probeIsNew = existing.length === 0;
    const candidateId = probeIsNew ? crypto.randomUUID() : existing[0].id;
    // Keep the copy's created_at equal to the truth's instead of stamping `now` on every
    // update — the R2 read path takes the newest row per key, so a re-stamped created_at would
    // make every row look as if it had been created at its last refresh.
    const candidateCreatedAt = probeIsNew ? now : String(existing[0].created_at ?? now);

    // Incremental pollers re-walk recently-seen posts every cron tick (see pollers/x-posts.ts's
    // runIncrementalPoll). Without this check every visit would burn a D1 write AND append an
    // identical row to the R2 copy, which has no dedup on write (append-only Iceberg sink; see
    // docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md).
    const unchanged = !probeIsNew && dynamicCols.every((c) => String(columnValues[c]) === String(existing[0][c] ?? ""));

    let id = candidateId;
    let createdAt = candidateCreatedAt;
    let isNew = probeIsNew;

    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // consumedPaths must be payload paths (resolve-props.ts's consumedPaths), never propIds —
    // propId ≠ payload field name.
    let rawData: string;
    // An empty array strips nothing — same net effect as omitting the param entirely (the
    // whole payload lands in raw_data), so it must warn the same way. `[]` is truthy, so a
    // bare `if (consumedPaths)` silently swallowed this case (task-7 fix round 2, same bug
    // class already fixed in x-users.ts's insertEvents for fix round 1's Minor 1) — check
    // length, not presence. Doesn't bite today because X/TikTok's contentProps always resolve
    // a non-empty consumedPaths, but a future source with an empty or missing mapping would
    // silently over-store with no warning otherwise.
    if (consumedPaths && consumedPaths.length > 0) {
      rawData = JSON.stringify(stripConsumedPaths(rawItem, consumedPaths));
    } else {
      console.warn(JSON.stringify({
        event: "upsertContentFromMetadata_raw_data_unfiltered",
        message: "consumedPaths not provided (or empty) — storing the entire payload in raw_data",
        channelId,
        sourceContentId,
      }));
      rawData = JSON.stringify(rawItem);
    }

    if (!unchanged) {
      const insertCols = ["id", "channel_id", "channel_type", "source_content_id", "list_id", "raw_data", ...dynamicCols, "created_at", "updated_at"];
      const insertPlaceholders = insertCols.map(() => "?");
      const insertParams = [candidateId, channelId, channelType, sourceContentId, listId ?? null, rawData, ...dynamicCols.map((c) => columnValues[c]), candidateCreatedAt, now];
      const updateSets = [
        // json_patch merges the new remainder into the stored one instead of replacing it, so a
        // partial payload (a webhook carrying fewer fields than the poller) can't wipe raw_data
        // keys an earlier, fuller write put there.
        "raw_data = json_patch(content.raw_data, excluded.raw_data)",
        "updated_at = excluded.updated_at",
        ...dynamicCols.map((c) => `${c} = excluded.${c}`),
      ];
      // Atomic dedup lives in the partial unique index, not in the probe above: the probe is
      // only a diff/id proposal, the index is what stops two concurrent pollers from creating two
      // rows for the same post.
      const conflictTarget = listId
        ? "(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL"
        : "(channel_id, source_content_id) WHERE list_id IS NULL";

      // RETURNING makes the WRITE authoritative for the id, closing the probe→mint→upsert race:
      // whether this statement inserted or hit the conflict, D1 hands back the id (and created_at)
      // of the row that actually exists. Everything downstream — the R2 copy, Vectorize, the
      // content.created event — must use that, or a lost race would ship an id matching no row in
      // any store. Goes through query() rather than run(), because run() discards result rows.
      const written = await db.query<{ id: string; created_at: string }>(
        `INSERT INTO content (${insertCols.join(", ")})
         VALUES (${insertPlaceholders.join(", ")})
         ON CONFLICT${conflictTarget} DO UPDATE SET
           ${updateSets.join(",\n           ")}
         RETURNING id, created_at`,
        insertParams
      );

      if (written.length > 0 && written[0].id) {
        id = written[0].id;
        createdAt = written[0].created_at ?? candidateCreatedAt;
        // A returned id other than the one just proposed means another writer inserted this key
        // first: the row is not new to the system, so no second content.created may fire for it.
        isNew = probeIsNew && id === candidateId;
      } else {
        // Never expected — D1 returns a row for both the INSERT and the DO UPDATE branch. Log
        // loudly rather than silently reverting to the pre-fix (unverified id) behaviour.
        console.warn(JSON.stringify({
          event: "upsertContentFromMetadata_upsert_returned_no_row",
          message: "INSERT ... RETURNING gave no row; falling back to the probe's proposed id",
          channelId,
          sourceContentId,
        }));
      }
    }

    await this.embedContents([{
      id,
      title: (columnValues.title as string) ?? null,
      content_text: (columnValues.content_text as string) ?? null,
      summary: null,
    }]);

    if (!unchanged) {
      // 完整行:读路径用 QUALIFY 取整行最新,漏一列就等于把那列写成 null。
      const record = this.buildContentRecord(
        { id, channelId, channelType, sourceContentId, listId, rawData, createdAt, updatedAt: now },
        columnValues
      );
      await this.sendContentRecord(record);
    }

    if (isNew && emitFlowEvent && this.flowQueue) {
      await this.flowQueue.send({
        tenantId: String(this.tenantId),
        eventType: "content.created",
        contentId: id,
        channelId,
        ...(listId ? { listId } : {}),
        payload: { channel_type: channelType, ...resolvedProps },
      }).catch((err) => {
        console.error(JSON.stringify({ event: "content_flow_queue_send_error", contentId: id, error: String(err) }));
      });
    }

    return isNew;
  }

  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; flowId: string },
    contentType: string = "TWEET"
  ): Promise<void> {
    const db = this.requireDb("recordPublishedContent");
    const now = new Date().toISOString();
    const values = { content_type: contentType, content_text: contentText };
    const rawData = JSON.stringify(ref);

    // This writes into the same (channel_id, source_content_id) key space every other writer
    // uses, and that key is backed by a UNIQUE index — a bare INSERT with a fresh uuid would
    // throw the moment the same sourceContentId is published twice. Probe first so the id stays
    // stable per business key (flow logs / Vectorize / ref.generatedFromContentId all key off
    // `id`), then upsert.
    const existing = await db.query<{ id: string; created_at: string }>(
      "SELECT id, created_at FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id IS NULL",
      [channelId, sourceContentId]
    );
    const candidateId = existing.length > 0 ? existing[0].id : crypto.randomUUID();
    const candidateCreatedAt = existing.length > 0 ? existing[0].created_at : now;

    // Same probe→mint→upsert race as upsertContentFromMetadata: RETURNING makes the write, not
    // the probe, authoritative for the id the R2 copy is built with.
    const written = await db.query<{ id: string; created_at: string }>(
      `INSERT INTO content (id, channel_id, channel_type, content_type, source_content_id, content_text, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, source_content_id) WHERE list_id IS NULL DO UPDATE SET
         content_type = excluded.content_type,
         content_text = excluded.content_text,
         raw_data = excluded.raw_data,
         updated_at = excluded.updated_at
       RETURNING id, created_at`,
      [candidateId, channelId, channelType, contentType, sourceContentId, contentText, rawData, candidateCreatedAt, now]
    );

    let id = candidateId;
    let createdAt = candidateCreatedAt;
    if (written.length > 0 && written[0].id) {
      id = written[0].id;
      createdAt = written[0].created_at ?? candidateCreatedAt;
    } else {
      console.warn(JSON.stringify({
        event: "recordPublishedContent_upsert_returned_no_row",
        message: "INSERT ... RETURNING gave no row; falling back to the probe's proposed id",
        channelId,
        sourceContentId,
      }));
    }

    // `status` no longer exists as a column in either store — the 2026-07-25 plan dropped the
    // concept outright rather than inventing a replacement (published-ness now lives only in
    // raw_data's ref).
    const record = this.buildContentRecord(
      { id, channelId, channelType, sourceContentId, listId: null, rawData, createdAt, updatedAt: now },
      values
    );
    await this.sendContentRecord(record);
  }

  // Trigger content is NOT persisted: a flow trigger only needs "have I seen this id before", so
  // it stays in entity_state's dedup ledger and never reaches the content table. This is the
  // other side of upsertContentFromMetadata's flowType gate.
  async recordTriggerContentSeen(
    channelId: string,
    secondaryId: string,
    sourceContentId: string
  ): Promise<boolean> {
    if (!sourceContentId) throw new Error("recordTriggerContentSeen: missing source_content_id");
    if (!this.entityState) throw new Error("ContentService.recordTriggerContentSeen: entityState is required");
    return await this.entityState.markSeen({ entity: "content_trigger", channelId, secondaryId, sourceId: sourceContentId });
  }

  async emitContentTriggerEvent(
    channelId: string,
    channelType: ChannelType,
    secondaryFieldName: "listId" | "subscriptionChannelId",
    secondaryValue: string,
    resolvedProps: Record<string, unknown>
  ): Promise<void> {
    if (!this.flowQueue) return;
    await this.flowQueue.send({
      tenantId: String(this.tenantId),
      eventType: "content.created",
      contentId: crypto.randomUUID(),
      channelId,
      ...(secondaryValue ? { [secondaryFieldName]: secondaryValue } : {}),
      payload: { channel_type: channelType, ...resolvedProps },
    }).catch((err) => {
      console.error(JSON.stringify({ event: "content_trigger_queue_send_error", channelId, error: String(err) }));
    });
  }

  // COALESCE ordering (carried over from the R2 phase, where it was a fix): ordering by
  // source_updated_at alone dumped every row whose source doesn't publish that field — X posts,
  // TikTok videos, i.e. most of the library — into an arbitrary NULL block at the bottom.
  async list(channelType?: ChannelType): Promise<ContentRow[]> {
    const db = this.requireDb("list");
    const order = "ORDER BY COALESCE(source_updated_at, source_created_at, created_at) DESC";
    if (channelType) {
      return await db.query<ContentRow>(
        `SELECT ${CONTENT_READ_PROJECTION} FROM content WHERE channel_type = ? ${order}`,
        [channelType]
      );
    }
    return await db.query<ContentRow>(`SELECT ${CONTENT_READ_PROJECTION} FROM content ${order}`);
  }

  async get(id: string): Promise<ContentRow | null> {
    const db = this.requireDb("get");
    const rows = await db.query<ContentRow>(
      `SELECT ${CONTENT_READ_PROJECTION} FROM content WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // D1 is the truth, so this is a real in-place UPDATE — no read-modify-write dance. The R2 copy
  // is append-only and its read path takes one whole row via QUALIFY, so the copy still needs the
  // COMPLETE row: read the freshly-updated D1 row back and rebuild it through buildContentRecord
  // (like every other writer) rather than sending just {id, title}, which would null every other
  // column in the copy.
  async update(id: string, fields: { title?: string; summary?: string }): Promise<void> {
    const db = this.requireDb("update");
    const now = new Date().toISOString();

    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
    if (fields.summary !== undefined) { sets.push("summary = ?"); params.push(fields.summary); }
    sets.push("updated_at = ?");
    params.push(now, id);

    const result = await db.run(`UPDATE content SET ${sets.join(", ")} WHERE id = ?`, params);
    // There is no "found but deleted" case any more: D1 deletes are physical, so not-found is
    // the only failure mode (the R2-as-truth phase had to tell the two apart to keep a PATCH
    // from resurrecting a tombstoned row).
    if (result.changes === 0) throw new Error(`ContentService.update: content ${id} not found`);

    const rows = await db.query<Record<string, unknown>>(
      `SELECT ${CONTENT_READ_PROJECTION} FROM content WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) throw new Error(`ContentService.update: content ${id} not found`);
    const row = rows[0];

    const record = this.buildContentRecord(
      {
        id,
        channelId: (row.channel_id as string | null) ?? null,
        channelType: row.channel_type as ChannelType,
        sourceContentId: row.source_content_id as string,
        listId: (row.list_id as string | null) ?? null,
        rawData: row.raw_data as string,
        createdAt: row.created_at as string,
        updatedAt: (row.updated_at as string) ?? now,
        isDeleted: 0,
      },
      row
    );
    await this.sendContentRecord(record);

    // Vectorize is still live (delete() below removes from it), so an edit that changes the
    // searchable text must refresh the embedding — otherwise semantic search keeps ranking on
    // text the user already replaced, with no path to ever catch up (7.3 fix). The values come
    // off the re-read D1 row, i.e. the truth, not off `fields`.
    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      await this.embedContents([{
        id,
        title: (row.title as string | null) ?? null,
        content_text: (row.content_text as string | null) ?? null,
        summary: (row.summary as string | null) ?? null,
      }]);
    }
  }

  // Writes an R2 logical-delete tombstone straight from caller-known identity, without reading
  // any row first — the escape hatch for a delete whose row is NOT in D1: a historical row that
  // only ever existed during the R2-as-truth phase, or one whose D1 lookup misses. Every
  // non-audit value column is left null (title/text/counts are unknowable without a real read),
  // but is_deleted=1 lands durably, so the row goes invisible to every R2 reader (outerWhere
  // filters it) the instant this is sent; a later real write for the same key is a normal
  // append, never a merge with this placeholder's null columns. webhook.ts's post.delete uses it
  // as the fallback when its D1 lookup by source_content_id finds nothing, instead of 500-ing.
  async deleteByKnownIdentity(
    id: string,
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    listId: string | null = null
  ): Promise<void> {
    const now = new Date().toISOString();
    const record = this.buildContentRecord(
      { id, channelId, channelType, sourceContentId, listId, rawData: "{}", createdAt: now, updatedAt: now, isDeleted: 1 },
      {}
    );
    await this.sendContentRecord(record);
  }

  // D1 hard-deletes (the row leaves the truth), then the R2 copy gets a tombstone: that sink is
  // append-only and has no DELETE, so `is_deleted = 1` on an otherwise complete copy of the row
  // is how a delete is represented there. Reading the row BEFORE the delete is what makes that
  // complete row possible.
  async delete(id: string): Promise<void> {
    const db = this.requireDb("delete");
    const rows = await db.query<Record<string, unknown>>(
      `SELECT ${CONTENT_READ_PROJECTION} FROM content WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) throw new Error(`ContentService.delete: content ${id} not found`);
    const row = rows[0];

    await db.run("DELETE FROM content WHERE id = ?", [id]);

    const now = new Date().toISOString();
    const record = this.buildContentRecord(
      {
        id,
        channelId: (row.channel_id as string | null) ?? null,
        channelType: row.channel_type as ChannelType,
        sourceContentId: row.source_content_id as string,
        listId: (row.list_id as string | null) ?? null,
        rawData: row.raw_data as string,
        createdAt: row.created_at as string,
        updatedAt: now,
        isDeleted: 1,
      },
      row
    );
    await this.sendContentRecord(record);
    await this.vectorize.deleteByIds([id]);
  }

  private buildEmbeddingText(item: EmbeddingInput): string {
    const parts = [item.title || item.content_text || ""];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }

  private async embedContents(items: EmbeddingInput[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => this.buildEmbeddingText(item));
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as {
      data: number[][];
    };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      namespace: this.namespace,
      metadata: {
        type: "content",
        content_id: item.id,
        title: item.title ?? "",
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
