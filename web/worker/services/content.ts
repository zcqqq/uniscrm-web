import type { ContentItem } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

interface ImportInput {
  filename: string;
  title: string;
  summary: string | null;
  file_modified_at: string | null;
}

export class ContentService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  async importBatch(userId: string, items: ImportInput[]): Promise<ContentItem[]> {
    const now = new Date().toISOString();
    const results: ContentItem[] = [];

    for (const item of items) {
      const existing = await this.db
        .prepare("SELECT id FROM contents WHERE user_id = ? AND filename = ?")
        .bind(userId, item.filename)
        .first<{ id: string }>();

      const id = existing?.id ?? crypto.randomUUID();

      if (existing) {
        await this.db
          .prepare("UPDATE contents SET title = ?, summary = ?, file_modified_at = ?, updated_at = ? WHERE id = ?")
          .bind(item.title, item.summary, item.file_modified_at, now, id)
          .run();
      } else {
        await this.db
          .prepare("INSERT INTO contents (id, user_id, filename, title, summary, file_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, userId, item.filename, item.title, item.summary, item.file_modified_at, now, now)
          .run();
      }

      results.push({
        id, user_id: userId, filename: item.filename, title: item.title,
        summary: item.summary, status: "new", file_modified_at: item.file_modified_at,
        created_at: now, updated_at: now,
      });
    }

    await this.embedContents(userId, results);
    return results;
  }

  async listByUser(userId: string): Promise<ContentItem[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM contents WHERE user_id = ? ORDER BY file_modified_at DESC")
      .bind(userId)
      .all<ContentItem>();
    return results;
  }

  async update(
    id: string,
    userId: string,
    fields: { title?: string; summary?: string; status?: string }
  ): Promise<void> {
    const existing = await this.db
      .prepare("SELECT * FROM contents WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ContentItem>();
    if (!existing) throw new Error("Content not found");

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); values.push(fields.title); }
    if (fields.summary !== undefined) { sets.push("summary = ?"); values.push(fields.summary); }
    if (fields.status !== undefined) { sets.push("status = ?"); values.push(fields.status); }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await this.db
      .prepare(`UPDATE contents SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      const updated: ContentItem = {
        ...existing,
        title: fields.title ?? existing.title,
        summary: fields.summary ?? existing.summary,
      };
      await this.embedContents(userId, [updated]);
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM contents WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await this.vectorize.deleteByIds([id]);
  }

  private buildEmbeddingText(item: ContentItem): string {
    const parts = [item.title];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }

  private async embedContents(userId: string, items: ContentItem[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => this.buildEmbeddingText(item));
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as { data: number[][] };

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
