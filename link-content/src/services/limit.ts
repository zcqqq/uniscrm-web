import type { TenantDataDB } from "../../../shared/tenant-data-db";

const MAX_ITEMS = 100;

export class LimitService {
  constructor(
    private tenantDb: TenantDataDB,
    private vectorize: VectorizeIndex
  ) {}

  async checkLimit(incomingCount: number): Promise<{
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

  async enforceLimit(count: number): Promise<void> {
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
