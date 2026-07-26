import { describe, it, expect } from "vitest";
import { EntityStateStore } from "../../src/services/entity-state";

// 内存版 D1 stub:只实现 entity_state 用到的语句形态(INSERT OR IGNORE / SELECT / UPDATE),
// 语义与 SQLite 一致。fingerprint 相关分支(claim/rollbackFingerprint)随 task 9 删除而移除。
function createFakeD1() {
  const rows = new Map<string, Record<string, unknown>>();
  const keyOf = (p: unknown[]) => p.slice(0, 5).join("\x1f");

  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO entity_state")) {
                const k = keyOf(params);
                if (rows.has(k)) return { meta: { changes: 0 } };
                rows.set(k, {
                  tenant_id: params[0], entity: params[1], channel_id: params[2],
                  secondary_id: params[3], source_id: params[4],
                  entity_id: params[5], fingerprint: params[6],
                  seen_at: params[7], updated_at: params[8],
                  is_follow: null, is_followed: null,
                });
                return { meta: { changes: 1 } };
              }
              // is_followed FIRST: "UPDATE entity_state SET is_follow" is a prefix of
              // "...SET is_followed", so testing the shorter form first would swallow every
              // is_followed write and silently store it in the wrong column.
              if (sql.includes("UPDATE entity_state SET is_followed")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.is_followed = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE entity_state SET is_follow")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.is_follow = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`fake D1: unhandled run() for ${sql}`);
            },
            async first() {
              if (sql.includes("WHERE tenant_id = ? AND entity_id = ?")) {
                // Real D1 projects only the selected columns; this branch is only
                // ever hit by getFollowByEntityId's two-column SELECT, so mirror that
                // instead of leaking the whole stored row into the assertion.
                for (const row of rows.values()) {
                  if (row.tenant_id === params[0] && row.entity_id === params[1]) {
                    return { is_follow: row.is_follow, is_followed: row.is_followed };
                  }
                }
                return null;
              }
              return rows.get(keyOf(params)) ?? null;
            },
          };
        },
      };
    },
  };
}

describe("EntityStateStore.markSeen", () => {
  it("returns true only the first time — this is the flow-trigger dedup", async () => {
    const store = new EntityStateStore(createFakeD1() as any, 7);
    const key = { entity: "content_trigger" as const, channelId: "c1", secondaryId: "list1", sourceId: "t1" };
    expect(await store.markSeen(key)).toBe(true);
    expect(await store.markSeen(key)).toBe(false);
  });
});

// The `user` path no longer takes its identity from claim(): per-tenant D1's
// INSERT ... RETURNING decides the uuid, and entity_state only mirrors the two follow columns
// flow hot-reads. ensureEntity is how that row gets created carrying the id D1 chose.
describe("EntityStateStore.ensureEntity", () => {
  const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };

  it("creates the row with the caller's entity_id so both stores agree on the uuid", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);

    await store.ensureEntity(key, "d1-minted-id");

    expect((await store.get(key))?.entity_id).toBe("d1-minted-id");
  });

  it("is idempotent — a second call never churns the stored entity_id", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);

    await store.ensureEntity(key, "first-id");
    await store.ensureEntity(key, "second-id");

    expect((await store.get(key))?.entity_id).toBe("first-id");
  });

  it("leaves a row created by ensureEntity writable by setFollow — the whole point of creating it", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);

    await store.ensureEntity(key, "d1-minted-id");
    await store.setFollow(key, "is_followed", 1);

    expect(await store.getFollowByEntityId("d1-minted-id")).toEqual({ is_follow: null, is_followed: 1 });
  });
});

describe("EntityStateStore follow state", () => {
  it("round-trips is_follow and leaves is_followed untouched", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);
    const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };
    const entityId = "d1-minted-id";
    await store.ensureEntity(key, entityId);

    await store.setFollow(key, "is_follow", 1);

    expect(await store.getFollowByEntityId(entityId)).toEqual({ is_follow: 1, is_followed: null });
  });

  it("returns null for an unknown entity_id rather than throwing", async () => {
    const store = new EntityStateStore(createFakeD1() as any, 7);
    expect(await store.getFollowByEntityId("nope")).toBeNull();
  });
});
