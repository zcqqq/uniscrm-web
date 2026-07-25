import type { ContentRow, ChannelType, Pipeline } from "../types";
import type { ChannelItem } from "../channels/interface";
import type { R2SqlEnv } from "../../../shared/r2-sql";
import { EntityStateStore, fingerprintOf } from "./entity-state";
import { listContents, getContent } from "./r2-entities";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// propId -> R2 `content` column. These are R2 Iceberg columns now, not D1 columns — tenant
// D1 no longer stores content rows (see .superpowers/sdd/2026-07-25-tenant-db-removal).
// A resolved prop not in this map only ever lives in raw_data. `list_id` deliberately does
// not go through this map: it's a dedup-key component the caller passes separately, not a
// value resolved from metadata props.
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
};

// Business-field subset used for entity_state change detection in upsertContentFromMetadata.
// created_at/updated_at deliberately excluded, or every call would look "changed".
const CONTENT_TABLE_COLUMNS = Object.values(CONTENT_COLUMN_MAP);

// propIds from CONTENT_COLUMN_MAP's keys — every propId that actually lands in a named R2
// `content` column. Exported so a caller computing consumedPaths (pollers/resolve-props.ts)
// before calling upsertContentFromMetadata can pass this as consumedPaths' `allowedPropIds`
// filter, so a metadata prop that has a dataId but no CONTENT_COLUMN_MAP entry doesn't get
// treated as "consumed" and stripped out of raw_data with nowhere else to land — the same bug
// class the task-5 fix round caught on the user path (profile_image_url/description had a
// dataId but no R2 `user` column, and were being destroyed). No current caller supplies
// consumedPaths for content yet (Task 6/7 wires that), so this is a preemptive guard, not a
// fix for a live bug — see content.test.ts's "raw_data filtering" tests for the guard in use.
export const CONTENT_MAPPED_PROP_IDS = new Set(Object.keys(CONTENT_COLUMN_MAP));

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
// just to satisfy the old signature, silently omitting the R2-only columns (list_id,
// cover_image_url, bookmark_count, ...) that TypeScript's excess-property check on `status`
// (removed — the column no longer exists, see task-4-report.md) had been masking: once an object
// literal has one excess property, TS skips reporting *missing* ones for that same literal, so
// those omissions were never actually caught by the compiler. Narrowing the type to exactly what
// embedding uses fixes both problems at once instead of padding three call sites with 15 fake
// nulls apiece.
type EmbeddingInput = Pick<ContentRow, "id" | "title" | "content_text" | "summary">;

export class ContentService {
  private namespace: string;

  constructor(
    private entityState: EntityStateStore,
    private vectorize: VectorizeIndex,
    private ai: Ai,
    private tenantId: number,
    private pipelineContent?: Pipeline,
    private flowQueue?: Queue,
    private r2Env?: R2SqlEnv
  ) {
    this.namespace = `tenant-${tenantId}`;
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

  private async sendContentRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.pipelineContent) return;
    await this.pipelineContent.send([record]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_content_error", contentId: record.id, error: String(err) }));
    });
  }

  async syncBatch(
    channelType: ChannelType,
    items: ChannelItem[]
  ): Promise<SyncResult> {
    const now = new Date().toISOString();

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: EmbeddingInput[] = [];

    for (const item of items) {
      const rawData = JSON.stringify(item.raw_data || {});
      const values = {
        source_updated_at: item.source_updated_at,
        title: item.title,
        summary: item.summary,
        source_url: item.source_url,
      };
      const fingerprint = await fingerprintOf(values, ["source_updated_at", "title", "summary", "source_url"]);

      // LOCAL/NOTION/TIKTOK imports (the only callers of syncBatch) have no channel_id at sync
      // time. Using "" here would key every import type on the same ("", "", source_content_id)
      // — so syncing {LOCAL, id:"1"} then {NOTION, id:"1"} would collide: the second claim
      // returns the first item's uuid, and the R2 partition key (channel_id, list_id,
      // source_content_id) — which also has no channel_type dimension — would silently
      // overwrite the LOCAL row with the NOTION one. For a channel-less import the channel
      // *type* is the channel, so using it as channel_id is honest, not a workaround: it keeps
      // the required `channel_id` column non-null (a genuine schema requirement — R2 Pipelines
      // silently drops records with a null required field) and makes the partition key
      // (channelType, null, source_content_id), which cannot collide across types.
      const key = {
        entity: "content" as const,
        channelId: channelType,
        secondaryId: "",
        sourceId: item.source_content_id,
      };
      const { entityId: id, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

      if (unchanged) {
        skipped++;
        continue;
      }

      needsEmbedding.push({
        id,
        title: item.title,
        content_text: null,
        summary: item.summary,
      });

      const record = this.buildContentRecord(
        { id, channelId: channelType, channelType, sourceContentId: item.source_content_id, listId: null, rawData, createdAt: now, updatedAt: now },
        values
      );
      await this.sendContentRecord(record);

      if (isNew) added++;
      else updated++;
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
    // content at all and shipped full tweet payloads to R2. Omitting this parameter is loud
    // (console.warn once) rather than silently over-storing.
    consumedPaths?: string[]
  ): Promise<boolean> {
    const sourceContentId = String(resolvedProps.source_content_id ?? "");
    if (!sourceContentId) throw new Error("upsertContentFromMetadata: missing source_content_id");

    const now = new Date().toISOString();

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }

    // 指纹只覆盖会变的业务字段;created_at/updated_at 不参与,否则每次都判定为「变了」。
    const fingerprint = await fingerprintOf(columnValues, CONTENT_TABLE_COLUMNS);
    const key = {
      entity: "content" as const,
      channelId,
      secondaryId: listId ?? "",
      sourceId: sourceContentId,
    };
    const { entityId: id, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // consumedPaths must be payload paths (resolve-props.ts's consumedPaths), never propIds —
    // propId ≠ payload field name.
    let rawData: string;
    if (consumedPaths) {
      rawData = JSON.stringify(stripConsumedPaths(rawItem, consumedPaths));
    } else {
      console.warn(JSON.stringify({
        event: "upsertContentFromMetadata_raw_data_unfiltered",
        message: "consumedPaths not provided — storing the entire payload in raw_data",
        channelId,
        sourceContentId,
      }));
      rawData = JSON.stringify(rawItem);
    }

    await this.embedContents([{
      id,
      title: (columnValues.title as string) ?? null,
      content_text: (columnValues.content_text as string) ?? null,
      summary: null,
    }]);

    if (this.pipelineContent && this.tenantId && !unchanged) {
      // 完整行:读路径用 QUALIFY 取整行最新,漏一列就等于把那列写成 null。
      const record = this.buildContentRecord(
        { id, channelId, channelType, sourceContentId, listId, rawData, createdAt: now, updatedAt: now },
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
    const now = new Date().toISOString();
    const values = { content_type: contentType, content_text: contentText };

    // Under D1 a bare crypto.randomUUID() was harmless because `id` was the primary key. Under
    // R2 the read-time business key is (channel_id, list_id, source_content_id) and this method
    // writes into that same key space — minting a fresh uuid per call would let publishing the
    // same sourceContentId twice produce two different `id`s in one partition, even though
    // flow logs / Vectorize / ref.generatedFromContentId all key off `id`. Route through
    // entityState.claim like every other writer so the id is stable per business key.
    const fingerprint = await fingerprintOf(values, ["content_type", "content_text"]);
    const { entityId: id } = await this.entityState.claim(
      { entity: "content", channelId, secondaryId: "", sourceId: sourceContentId },
      fingerprint
    );
    const rawData = JSON.stringify(ref);

    // `status` no longer exists as an R2 column — the plan drops the concept entirely
    // rather than inventing a replacement (published-ness now lives only in `ref`/raw_data).
    const record = this.buildContentRecord(
      { id, channelId, channelType, sourceContentId, listId: null, rawData, createdAt: now, updatedAt: now },
      values
    );
    await this.sendContentRecord(record);
  }

  async recordTriggerContentSeen(
    channelId: string,
    secondaryId: string,
    sourceContentId: string
  ): Promise<boolean> {
    if (!sourceContentId) throw new Error("recordTriggerContentSeen: missing source_content_id");
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

  async list(channelType?: ChannelType): Promise<ContentRow[]> {
    if (!this.r2Env) throw new Error("ContentService.list: r2Env is required");
    return await listContents(this.r2Env, this.tenantId, channelType);
  }

  async get(id: string): Promise<ContentRow | null> {
    if (!this.r2Env) throw new Error("ContentService.get: r2Env is required");
    return await getContent(this.r2Env, this.tenantId, id);
  }

  // R2 是 append-only 且读路径按 QUALIFY 取整行最新,所以"改一个字段"必须
  // 读整行 → 覆盖 → 整行回写。只发 {id, title} 会把其余列全部写成 null。
  // Routes through buildContentRecord (like every other writer) rather than spreading the read
  // row directly, so the column set is guaranteed by the one builder instead of resting on
  // CONTENT_COLUMNS and R2_CONTENT_VALUE_COLUMNS staying manually in sync (I4).
  async update(id: string, fields: { title?: string; summary?: string }): Promise<void> {
    if (!this.r2Env) throw new Error("ContentService.update: r2Env is required");
    // includeDeleted: true — update() must see a deleted row to tell "not found" apart from
    // "found but deleted" below, rather than getContent's default filter silently reporting
    // both as "not found".
    const row = (await getContent(this.r2Env, this.tenantId, id, { includeDeleted: true })) as unknown as Record<string, unknown> | null;
    if (!row) throw new Error(`ContentService.update: content ${id} not found`);
    // Editing a deleted item is a caller bug (stale UI, race with a concurrent delete), not
    // something to silently repair by resurrecting the row — that was the I1 bug: forcing
    // is_deleted = 0 here turned "PATCH a deleted item" into an accidental undelete.
    if (row.is_deleted === 1) throw new Error(`ContentService.update: content ${id} is deleted`);

    const now = new Date().toISOString();
    const values: Record<string, unknown> = { ...row };
    if (fields.title !== undefined) values.title = fields.title;
    if (fields.summary !== undefined) values.summary = fields.summary;

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
        isDeleted: 0,
      },
      values
    );
    await this.sendContentRecord(record);

    // Vectorize is still live (delete() below removes from it), so an edit that changes the
    // searchable text must refresh the embedding — otherwise semantic search keeps ranking on
    // text the user already replaced, with no path to ever catch up (7.3 fix).
    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      await this.embedContents([{
        id,
        title: (values.title as string | null) ?? null,
        content_text: (row.content_text as string | null) ?? null,
        summary: (values.summary as string | null) ?? null,
      }]);
    }
  }

  // 逻辑删除:uniscrm-web/CLAUDE.md「重要的被关联数据用逻辑删除」,
  // 而且 Iceberg sink 本来也没有 DELETE。Also routed through buildContentRecord (I4).
  async delete(id: string): Promise<void> {
    if (!this.r2Env) throw new Error("ContentService.delete: r2Env is required");
    // includeDeleted: true — delete() must be idempotent against an already-deleted row rather
    // than reporting "not found" for it.
    const row = (await getContent(this.r2Env, this.tenantId, id, { includeDeleted: true })) as unknown as Record<string, unknown> | null;
    if (!row) throw new Error(`ContentService.delete: content ${id} not found`);

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
