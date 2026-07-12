const MAX_ITEMS = 100;

export class ProductLimitService {
  constructor(private db: D1Database, private vectorize: VectorizeIndex) {}

  async checkLimit(userId: string, incomingCount: number): Promise<{
    allowed: boolean;
    overflow: number;
    wouldDelete: { id: string; title: string; created_at: string }[];
  }> {
    const { count } = await this.db
      .prepare("SELECT COUNT(*) as count FROM products WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>() ?? { count: 0 };

    const total = count + incomingCount;
    if (total <= MAX_ITEMS) return { allowed: true, overflow: 0, wouldDelete: [] };

    const overflow = total - MAX_ITEMS;
    const { results } = await this.db
      .prepare("SELECT id, title, created_at FROM products WHERE user_id = ? ORDER BY created_at ASC LIMIT ?")
      .bind(userId, overflow)
      .all<{ id: string; title: string; created_at: string }>();

    return { allowed: false, overflow, wouldDelete: results };
  }

  async enforceLimit(userId: string, count: number): Promise<void> {
    const { results } = await this.db
      .prepare("SELECT id FROM products WHERE user_id = ? ORDER BY created_at ASC LIMIT ?")
      .bind(userId, count)
      .all<{ id: string }>();

    const ids = results.map(r => r.id);
    if (ids.length === 0) return;

    await this.vectorize.deleteByIds(ids);

    const placeholders = ids.map(() => "?").join(",");
    await this.db
      .prepare(`DELETE FROM products WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
  }
}
