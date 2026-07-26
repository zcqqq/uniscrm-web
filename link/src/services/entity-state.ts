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

// 变更检测用的指纹。用 SHA-256 而不是短哈希:碰撞意味着「变了但没重发 R2」,
// 也就是静默丢数据 —— 与「数据准确性 > 一切」冲突。
// 缺字段与空串视为等价,避免上游 undefined/"" 的抖动引起假变更。
export async function fingerprintOf(
  values: Record<string, unknown>,
  fields: string[]
): Promise<string> {
  const canonical = [...fields]
    .sort()
    .map((f) => {
      const v = values[f];
      return `${f}=${v === undefined || v === null ? "" : String(v)}`;
    })
    .join("\x1f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// R2 Data Catalog 是 append-only、无唯一索引、无原子插入,所以这三件事只能落在 D1:
//   1. 「见过吗」—— flow trigger 去重(靠 PK + INSERT OR IGNORE 的原子性)
//   2. 「变了吗」—— poller 每 tick 重走已抓过的页,没有它会全量重发 R2
//   3. 「我们的 uuid 是什么」—— flow log / vectorize / pending 队列都引用它,必须稳定
// 每行只有 key + 指纹 + 两个 int,不含任何业务字段。
export class EntityStateStore {
  constructor(private db: D1Database, private tenantId: number) {}

  private sec(key: EntityStateKey): string {
    return key.secondaryId ?? "";
  }

  async claim(
    key: EntityStateKey,
    fingerprint: string
  ): Promise<{ entityId: string; isNew: boolean; unchanged: boolean }> {
    const now = new Date().toISOString();
    const candidate = crypto.randomUUID();

    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_state
           (tenant_id, entity, channel_id, secondary_id, source_id, entity_id, fingerprint, seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId, candidate, fingerprint, now, now)
      .run();

    if (inserted.meta.changes > 0) {
      return { entityId: candidate, isNew: true, unchanged: false };
    }

    const row = await this.get(key);
    if (!row) {
      // PK 冲突后又读不到 —— 只可能是并发删除,当前代码没有删除路径,所以这是真异常。
      throw new Error(`EntityStateStore.claim: row vanished for ${key.entity}/${key.sourceId}`);
    }
    if (row.fingerprint === fingerprint) {
      return { entityId: row.entity_id, isNew: false, unchanged: true };
    }

    await this.db
      .prepare(
        `UPDATE entity_state SET fingerprint = ?, updated_at = ?
         WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
      )
      .bind(fingerprint, now, this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .run();

    return { entityId: row.entity_id, isNew: false, unchanged: false };
  }

  // 用调用方给定的 entity_id 建行(已存在则原样保留)。claim() 自己 mint uuid,而
  // user 的 id 现在由 per-tenant D1 的 INSERT ... RETURNING 决定(2026-07-26 计划:
  // user/content 真相回到 D1),两边必须是同一个 uuid,所以需要这条「按给定 id 建行」。
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

  // Undoes claim()'s fingerprint commit when the caller's R2 pipeline send failed AFTER claim()
  // already recorded the new fingerprint as durable (final review I4). Without this, a transient
  // pipeline error permanently strands the row: claim() commits fingerprint=F, the send to R2
  // rejects, and the caller only logs — the next poll/webhook computes the SAME fingerprint F,
  // sees it already matches, and skips resending forever (content.ts:306's `unchanged` early
  // return, and the mirror in x-users.ts). Setting fingerprint back to NULL (rather than trying
  // to restore the prior value) is deliberately simple and always correct: fingerprintOf's SHA-256
  // output is never NULL, so the next claim() call — whatever fingerprint it computes — is
  // guaranteed to mismatch NULL and take the "changed" branch (unchanged: false), forcing a
  // resend. entity_id and every other column are untouched — this only ever un-claims the
  // fingerprint, never the identity.
  async rollbackFingerprint(key: EntityStateKey): Promise<void> {
    await this.db
      .prepare(
        `UPDATE entity_state SET fingerprint = NULL, updated_at = ?
         WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
      )
      .bind(new Date().toISOString(), this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
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
