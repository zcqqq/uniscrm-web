import type { TenantDataDB } from "../../../shared/tenant-data-db";

const MAX_ITEMS = 100;

export class LimitService {
  constructor(
    private tenantDb: TenantDataDB,
    private vectorize: VectorizeIndex
  ) {}

  async checkContentLimit(incomingCount: number): Promise<{
    allowed: boolean;
    overflow: number;
    wouldDelete: { id: string; title: string; created_at: string }[];
  }> {
    const rows = await this.tenantDb.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM content"
    );
    const count = rows[0]?.count ?? 0;

    const total = count + incomingCount;
    if (total <= MAX_ITEMS) return { allowed: true, overflow: 0, wouldDelete: [] };

    const overflow = total - MAX_ITEMS;
    const wouldDelete = await this.tenantDb.query<{ id: string; title: string; created_at: string }>(
      "SELECT id, title, created_at FROM content ORDER BY created_at ASC LIMIT ?",
      [overflow]
    );

    return { allowed: false, overflow, wouldDelete };
  }

  async enforceContentLimit(count: number): Promise<void> {
    const rows = await this.tenantDb.query<{ id: string }>(
      "SELECT id FROM content ORDER BY created_at ASC LIMIT ?",
      [count]
    );

    const ids = rows.map(r => r.id);
    if (ids.length === 0) return;

    await this.vectorize.deleteByIds(ids);

    const placeholders = ids.map(() => "?").join(",");
    await this.tenantDb.run(
      `DELETE FROM content WHERE id IN (${placeholders})`,
      ids
    );
  }
}

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
