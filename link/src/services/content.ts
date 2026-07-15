import type { TenantDataDB } from "../../../shared/tenant-data-db";
import type { ContentRow, ChannelType, Pipeline } from "../types";
import type { ChannelItem } from "../channels/interface";
import { PROPS } from "../../../metadata/props";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Same isInsight registry x-users.ts uses for the user/event pipelines — only
// props marked isInsight:true become dynamic columns on the R2 Iceberg tables.
const INSIGHT_PROPS = PROPS.filter((p) => p.isInsight);

// propId -> content column. All propIds here are 1:1 name matches with their column.
// A resolved prop not in this map only ever lives in raw_data.
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
};
const CONTENT_TABLE_COLUMNS = Object.values(CONTENT_COLUMN_MAP);

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export class ContentService {
  private namespace: string;

  constructor(
    private tenantDb: TenantDataDB,
    private vectorize: VectorizeIndex,
    private ai: Ai,
    private tenantId: number,
    private pipelineContent?: Pipeline,
    private flowQueue?: Queue
  ) {
    this.namespace = `tenant-${tenantId}`;
  }

  async syncBatch(
    channelType: ChannelType,
    items: ChannelItem[]
  ): Promise<SyncResult> {
    const now = new Date().toISOString();

    const existing = await this.tenantDb.query<{
      id: string;
      source_content_id: string;
      source_updated_at: string | null;
    }>(
      "SELECT id, source_content_id, source_updated_at FROM content WHERE channel_type = ?",
      [channelType]
    );

    const existingMap = new Map(existing.map((e) => [e.source_content_id, e]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: ContentRow[] = [];

    for (const item of items) {
      const ex = existingMap.get(item.source_content_id);

      if (ex && ex.source_updated_at === item.source_updated_at) {
        skipped++;
        continue;
      }

      const rawData = JSON.stringify(item.raw_data || {});

      if (ex) {
        await this.tenantDb.run(
          "UPDATE content SET title = ?, summary = ?, source_url = ?, source_updated_at = ?, raw_data = ?, updated_at = ? WHERE id = ?",
          [item.title, item.summary, item.source_url, item.source_updated_at, rawData, now, ex.id]
        );

        needsEmbedding.push({
          id: ex.id,
          channel_id: null,
          channel_type: channelType,
          content_type: null,
          source_content_id: item.source_content_id,
          title: item.title,
          content_text: null,
          summary: item.summary,
          status: "new",
          source_url: item.source_url,
          source_updated_at: item.source_updated_at,
          source_created_at: null,
          raw_data: rawData,
          created_at: now,
          updated_at: now,
        });
        updated++;
      } else {
        const id = crypto.randomUUID();
        await this.tenantDb.run(
          "INSERT INTO content (id, channel_type, source_content_id, title, summary, source_url, source_updated_at, raw_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, channelType, item.source_content_id, item.title, item.summary, item.source_url, item.source_updated_at, rawData, now, now]
        );

        needsEmbedding.push({
          id,
          channel_id: null,
          channel_type: channelType,
          content_type: null,
          source_content_id: item.source_content_id,
          title: item.title,
          content_text: null,
          summary: item.summary,
          status: "new",
          source_url: item.source_url,
          source_updated_at: item.source_updated_at,
          source_created_at: null,
          raw_data: rawData,
          created_at: now,
          updated_at: now,
        });
        added++;
      }
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
    listId?: string
  ): Promise<boolean> {
    const sourceContentId = String(resolvedProps.source_content_id ?? "");
    if (!sourceContentId) throw new Error("upsertContentFromMetadata: missing source_content_id");

    const existing = listId
      ? await this.tenantDb.query<Record<string, unknown> & { id: string }>(
          `SELECT id, ${CONTENT_TABLE_COLUMNS.join(", ")} FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id = ?`,
          [channelId, sourceContentId, listId]
        )
      : await this.tenantDb.query<Record<string, unknown> & { id: string }>(
          `SELECT id, ${CONTENT_TABLE_COLUMNS.join(", ")} FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id IS NULL`,
          [channelId, sourceContentId]
        );
    const isNew = existing.length === 0;
    const id = isNew ? crypto.randomUUID() : existing[0].id;
    const now = new Date().toISOString();
    const rawData = JSON.stringify(rawItem);

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }
    const dynamicCols = Object.keys(columnValues);
    // Incremental poller re-walks recently-seen posts every cron tick (see
    // pollers/x-posts.ts's runIncrementalPoll) — without this check, every visit resends
    // an unchanged content row to the R2 pipeline, which has no dedup on write (append-only
    // Iceberg sink; see docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md).
    const unchanged = !isNew && dynamicCols.every((c) => String(columnValues[c]) === String(existing[0][c] ?? ""));

    const insertCols = ["id", "channel_id", "channel_type", "source_content_id", "list_id", "raw_data", ...dynamicCols, "created_at", "updated_at"];
    const insertPlaceholders = ["?", "?", "?", "?", "?", "?", ...dynamicCols.map(() => "?"), "?", "?"];
    const insertParams = [id, channelId, channelType, sourceContentId, listId ?? null, rawData, ...dynamicCols.map((c) => columnValues[c]), now, now];
    const updateSets = [
      "raw_data = json_patch(content.raw_data, excluded.raw_data)",
      "updated_at = excluded.updated_at",
      ...dynamicCols.map((c) => `${c} = excluded.${c}`),
    ];
    const conflictTarget = listId
      ? "(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL"
      : "(channel_id, source_content_id) WHERE list_id IS NULL";

    await this.tenantDb.run(
      `INSERT INTO content (${insertCols.join(", ")})
       VALUES (${insertPlaceholders.join(", ")})
       ON CONFLICT${conflictTarget} DO UPDATE SET
         ${updateSets.join(",\n         ")}`,
      insertParams
    );

    await this.embedContents([{
      id,
      channel_id: channelId,
      channel_type: channelType,
      content_type: (columnValues.content_type as string) ?? null,
      source_content_id: sourceContentId,
      title: null,
      content_text: (columnValues.content_text as string) ?? null,
      summary: null,
      status: "new",
      source_url: null,
      source_updated_at: null,
      source_created_at: (columnValues.source_created_at as string) ?? null,
      raw_data: rawData,
      created_at: now,
      updated_at: now,
    }]);

    if (this.pipelineContent && this.tenantId && !unchanged) {
      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id,
        channel_id: channelId,
        channel_type: channelType,
        source_content_id: sourceContentId,
        created_at: now,
        updated_at: now,
      };
      // Only isInsight-marked props reach R2 — free-text fields like title/content_text
      // stay D1-only (raw_data), same rule x-users.ts follows for the user pipeline.
      // list_id intentionally does not join this record — R2 analytics collapses the same
      // tweet seen via two lists into one row, which is accepted for this phase (see plan's
      // Global Constraints).
      for (const prop of INSIGHT_PROPS) {
        if (prop.propId in resolvedProps) record[prop.propId] = resolvedProps[prop.propId];
      }
      await this.pipelineContent.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_content_error", error: String(err) }));
      });
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
    ref: { generatedFromContentId: string; flowId: string }
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.tenantDb.run(
      `INSERT INTO content (id, channel_id, channel_type, content_type, source_content_id, content_text, status, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, 'TWEET', ?, ?, ?, ?, ?, ?)`,
      [id, channelId, channelType, sourceContentId, contentText, "published", JSON.stringify(ref), now, now]
    );
  }

  async list(channelType?: ChannelType): Promise<ContentRow[]> {
    if (channelType) {
      return this.tenantDb.query<ContentRow>(
        "SELECT * FROM content WHERE channel_type = ? ORDER BY source_updated_at DESC",
        [channelType]
      );
    }
    return this.tenantDb.query<ContentRow>(
      "SELECT * FROM content ORDER BY source_updated_at DESC"
    );
  }

  async update(
    id: string,
    fields: { title?: string; summary?: string; status?: string }
  ): Promise<void> {
    const rows = await this.tenantDb.query<ContentRow>(
      "SELECT * FROM content WHERE id = ?",
      [id]
    );
    if (rows.length === 0) throw new Error("Content not found");
    const existing = rows[0];

    const VALID_STATUSES = ["new", "pending", "published", "ignored"];
    if (fields.status !== undefined && !VALID_STATUSES.includes(fields.status)) {
      throw new Error("Invalid status");
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); values.push(fields.title); }
    if (fields.summary !== undefined) { sets.push("summary = ?"); values.push(fields.summary); }
    if (fields.status !== undefined) { sets.push("status = ?"); values.push(fields.status); }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await this.tenantDb.run(
      `UPDATE content SET ${sets.join(", ")} WHERE id = ?`,
      values
    );

    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      const updatedItem: ContentRow = {
        ...existing,
        title: fields.title ?? existing.title,
        summary: fields.summary ?? existing.summary,
      };
      await this.embedContents([updatedItem]);
    }
  }

  async delete(id: string): Promise<void> {
    await this.tenantDb.run("DELETE FROM content WHERE id = ?", [id]);
    await this.vectorize.deleteByIds([id]);
  }

  private buildEmbeddingText(item: ContentRow): string {
    const parts = [item.title || item.content_text || ""];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }

  private async embedContents(items: ContentRow[]): Promise<void> {
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
