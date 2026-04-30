import type { ProductRow, CommerceChannelType } from "../types";
import type { CommerceChannelItem } from "../channels/interface";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export class ProductService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  async syncBatch(
    userId: string,
    channelType: CommerceChannelType,
    items: CommerceChannelItem[]
  ): Promise<SyncResult> {
    const now = new Date().toISOString();

    const { results: existing } = await this.db
      .prepare(
        "SELECT id, channel_source_id, source_modified_at FROM products WHERE user_id = ? AND channel_type = ?"
      )
      .bind(userId, channelType)
      .all<{ id: string; channel_source_id: string; source_modified_at: string | null }>();

    const existingMap = new Map(existing.map((e) => [e.channel_source_id, e]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: ProductRow[] = [];

    for (const item of items) {
      const ex = existingMap.get(item.channel_source_id);

      if (ex && ex.source_modified_at === item.source_modified_at) {
        skipped++;
        continue;
      }

      const row: ProductRow = {
        id: ex?.id ?? crypto.randomUUID(),
        user_id: userId,
        channel_type: channelType,
        channel_source_id: item.channel_source_id,
        title: item.title,
        description: item.description,
        source_url: item.source_url,
        source_modified_at: item.source_modified_at,
        created_at: now,
        updated_at: now,
      };

      if (ex) {
        await this.db
          .prepare(
            "UPDATE products SET title = ?, description = ?, source_url = ?, source_modified_at = ?, updated_at = ? WHERE id = ?"
          )
          .bind(item.title, item.description, item.source_url, item.source_modified_at, now, ex.id)
          .run();
        updated++;
      } else {
        await this.db
          .prepare(
            "INSERT INTO products (id, user_id, channel_type, channel_source_id, title, description, source_url, source_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(row.id, userId, channelType, item.channel_source_id, item.title, item.description, item.source_url, item.source_modified_at, now, now)
          .run();
        added++;
      }

      needsEmbedding.push(row);
    }

    await this.embedProducts(userId, needsEmbedding);
    return { added, updated, skipped };
  }

  async addSingle(
    userId: string,
    channelType: CommerceChannelType,
    item: CommerceChannelItem
  ): Promise<ProductRow> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        "INSERT INTO products (id, user_id, channel_type, channel_source_id, title, description, source_url, source_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, userId, channelType, item.channel_source_id, item.title, item.description, item.source_url, item.source_modified_at, now, now)
      .run();

    const row: ProductRow = {
      id,
      user_id: userId,
      channel_type: channelType,
      channel_source_id: item.channel_source_id,
      title: item.title,
      description: item.description,
      source_url: item.source_url,
      source_modified_at: item.source_modified_at,
      created_at: now,
      updated_at: now,
    };

    await this.embedProducts(userId, [row]);
    return row;
  }

  async listByUser(userId: string): Promise<ProductRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM products WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(userId)
      .all<ProductRow>();
    return results;
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM products WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await this.vectorize.deleteByIds([id]);
  }

  private async embedProducts(userId: string, items: ProductRow[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => {
      const parts = [item.title];
      if (item.description) parts.push(item.description);
      return parts.join(" | ");
    });

    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as {
      data: number[][];
    };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        type: "product",
        user_id: userId,
        product_id: item.id,
        title: item.title,
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
