export type EntityKind = "user" | "content" | "content_trigger";

export interface EntityStateKey {
  entity: EntityKind;
  channelId: string;
  secondaryId?: string;
  sourceId: string;
}

export interface EntityStateRow {
  entity_id: string;
  fingerprint: string | null;
  is_follow: number | null;
  is_followed: number | null;
}

// R2 Data Catalog 是 append-only、无唯一索引、无原子插入,所以这两件事只能落在 D1:
//   1. 「见过吗」—— flow trigger 去重(靠 PK + INSERT OR IGNORE 的原子性,markSeen)
//   2. follow 位镜像 —— flow 每次 action 都热读 is_follow/is_followed(ensureEntity/setFollow)
// 「变了吗」这条(fingerprint 变更检测 + claim()/rollbackFingerprint())随 2026-07-26 计划
// user/content 真相回到 D1 而失效并在 task 9 删除:变更检测已改成 D1 列比对(见 content.ts/
// x-users.ts 的 diff 逻辑)。fingerprint 列仍留在表结构里(不迁移删列),但代码不再写它。
// 每行只有 key + 指纹(historical, 恒为 NULL)+ 两个 int,不含任何业务字段。
export class EntityStateStore {
  constructor(private db: D1Database, private tenantId: number) {}

  private sec(key: EntityStateKey): string {
    return key.secondaryId ?? "";
  }

  // 用调用方给定的 entity_id 建行(已存在则原样保留)。user 的 id 现在由 per-tenant D1 的
  // INSERT ... RETURNING 决定(2026-07-26 计划:user/content 真相回到 D1),两边必须是同一个
  // uuid,所以需要这条「按给定 id 建行」(取代已删除的 claim() 自己 mint uuid 的旧路径)。
  // 建行本身是为了 setFollow —— 它是 UPDATE,行不存在就静默改 0 行,而 flow 每次 action
  // 都热读这两列(flow/src/index.ts resolveUserPropsForFilter)。fingerprint 留 NULL:
  // 变更检测已经改成 D1 列比对,这张表在 user 路径上只剩 follow 镜像这一个职责。
  async ensureEntity(key: EntityStateKey, entityId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_state
           (tenant_id, entity, channel_id, secondary_id, source_id, entity_id, fingerprint, seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId, entityId, null, now, now)
      .run();
  }

  // 纯去重:第一次见到返回 true。取代原来的 content_trigger_dedup 表。
  async markSeen(key: EntityStateKey): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_state
           (tenant_id, entity, channel_id, secondary_id, source_id, entity_id, fingerprint, seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId, crypto.randomUUID(), null, now, now)
      .run();
    return res.meta.changes > 0;
  }

  async get(key: EntityStateKey): Promise<EntityStateRow | null> {
    return await this.db
      .prepare(
        `SELECT entity_id, fingerprint, is_follow, is_followed FROM entity_state
         WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .first<EntityStateRow>();
  }

  async setFollow(key: EntityStateKey, field: "is_follow" | "is_followed", value: 0 | 1): Promise<void> {
    // field 是联合类型,不是外部输入,拼进 SQL 安全。
    const sql =
      field === "is_follow"
        ? `UPDATE entity_state SET is_follow = ?, updated_at = ?
           WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
        : `UPDATE entity_state SET is_followed = ?, updated_at = ?
           WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`;
    await this.db
      .prepare(sql)
      .bind(value, new Date().toISOString(), this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .run();
  }

  async getFollowByEntityId(
    entityId: string
  ): Promise<{ is_follow: number | null; is_followed: number | null } | null> {
    return await this.db
      .prepare(`SELECT is_follow, is_followed FROM entity_state WHERE tenant_id = ? AND entity_id = ?`)
      .bind(this.tenantId, entityId)
      .first<{ is_follow: number | null; is_followed: number | null }>();
  }
}
