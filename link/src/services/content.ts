import type { TenantDataDB } from "../../../shared/tenant-data-db";
import type { ContentRow, ChannelType } from "../types";
import type { ChannelItem } from "../channels/interface";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

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
    private tenantId: number
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
    const parts = [item.title];
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
        title: item.title,
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
