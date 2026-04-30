import type { ContentItemRow, ChannelType } from "../types";
import type { ChannelItem } from "../channels/interface";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export class ContentService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  async syncBatch(
    userId: string,
    channelType: ChannelType,
    items: ChannelItem[]
  ): Promise<SyncResult> {
    const now = new Date().toISOString();

    // Fetch existing items for this user+channel
    const { results: existing } = await this.db
      .prepare("SELECT id, channel_source_id, source_modified_at FROM content_items WHERE user_id = ? AND channel_type = ?")
      .bind(userId, channelType)
      .all<{ id: string; channel_source_id: string; source_modified_at: string | null }>();

    const existingMap = new Map(existing.map((e) => [e.channel_source_id, e]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: ContentItemRow[] = [];

    for (const item of items) {
      const ex = existingMap.get(item.channel_source_id);

      if (ex && ex.source_modified_at === item.source_modified_at) {
        skipped++;
        continue;
      }

      if (ex) {
        // Update existing
        await this.db
          .prepare(
            "UPDATE content_items SET title = ?, summary = ?, source_url = ?, source_modified_at = ?, updated_at = ? WHERE id = ?"
          )
          .bind(item.title, item.summary, item.source_url, item.source_modified_at, now, ex.id)
          .run();

        needsEmbedding.push({
          id: ex.id,
          user_id: userId,
          channel_type: channelType,
          channel_source_id: item.channel_source_id,
          title: item.title,
          summary: item.summary,
          status: "new",
          source_url: item.source_url,
          source_modified_at: item.source_modified_at,
          created_at: now,
          updated_at: now,
        });
        updated++;
      } else {
        // Insert new
        const id = crypto.randomUUID();
        await this.db
          .prepare(
            "INSERT INTO content_items (id, user_id, channel_type, channel_source_id, title, summary, source_url, source_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(id, userId, channelType, item.channel_source_id, item.title, item.summary, item.source_url, item.source_modified_at, now, now)
          .run();

        needsEmbedding.push({
          id,
          user_id: userId,
          channel_type: channelType,
          channel_source_id: item.channel_source_id,
          title: item.title,
          summary: item.summary,
          status: "new",
          source_url: item.source_url,
          source_modified_at: item.source_modified_at,
          created_at: now,
          updated_at: now,
        });
        added++;
      }
    }

    await this.embedContents(userId, needsEmbedding);
    return { added, updated, skipped };
  }

  async listByUser(userId: string, channelType?: ChannelType): Promise<ContentItemRow[]> {
    if (channelType) {
      const { results } = await this.db
        .prepare("SELECT * FROM content_items WHERE user_id = ? AND channel_type = ? ORDER BY source_modified_at DESC")
        .bind(userId, channelType)
        .all<ContentItemRow>();
      return results;
    }
    const { results } = await this.db
      .prepare("SELECT * FROM content_items WHERE user_id = ? ORDER BY source_modified_at DESC")
      .bind(userId)
      .all<ContentItemRow>();
    return results;
  }

  async update(
    id: string,
    userId: string,
    fields: { title?: string; summary?: string; status?: string }
  ): Promise<void> {
    const existing = await this.db
      .prepare("SELECT * FROM content_items WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ContentItemRow>();
    if (!existing) throw new Error("Content not found");

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

    await this.db
      .prepare(`UPDATE content_items SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      const updatedItem: ContentItemRow = {
        ...existing,
        title: fields.title ?? existing.title,
        summary: fields.summary ?? existing.summary,
      };
      await this.embedContents(userId, [updatedItem]);
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM content_items WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await this.vectorize.deleteByIds([id]);
  }

  private buildEmbeddingText(item: ContentItemRow): string {
    const parts = [item.title];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }

  private async embedContents(userId: string, items: ContentItemRow[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => this.buildEmbeddingText(item));
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as {
      data: number[][];
    };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        type: "content",
        user_id: userId,
        content_id: item.id,
        title: item.title,
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
