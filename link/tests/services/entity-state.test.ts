import { describe, it, expect, beforeEach } from "vitest";
import { EntityStateStore, fingerprintOf } from "../../src/services/entity-state";

// 内存版 D1 stub:只实现 entity_state 用到的三条语句形态,
// 语义与 SQLite 的 INSERT OR IGNORE / SELECT / UPDATE 一致。
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
              // Check the NULL-rollback form before the general "SET fingerprint = ?" branch:
              // both contain the substring "UPDATE entity_state SET fingerprint", but their
              // bound-param shapes differ (rollbackFingerprint has no leading fingerprint
              // param, since the SQL hardcodes NULL rather than binding it).
              if (sql.includes("SET fingerprint = NULL")) {
                const k = [params[1], params[2], params[3], params[4], params[5]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.fingerprint = null; row.updated_at = params[0]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE entity_state SET fingerprint")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.fingerprint = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
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

describe("fingerprintOf", () => {
  it("is stable for the same values regardless of key insertion order", async () => {
    const a = await fingerprintOf({ name: "Ann", username: "ann" }, ["name", "username"]);
    const b = await fingerprintOf({ username: "ann", name: "Ann" }, ["name", "username"]);
    expect(a).toBe(b);
  });

  it("changes when any tracked field changes", async () => {
    const a = await fingerprintOf({ name: "Ann" }, ["name"]);
    const b = await fingerprintOf({ name: "Bob" }, ["name"]);
    expect(a).not.toBe(b);
  });

  it("treats a missing field and an empty string identically", async () => {
    const a = await fingerprintOf({ name: "Ann" }, ["name", "bio"]);
    const b = await fingerprintOf({ name: "Ann", bio: "" }, ["name", "bio"]);
    expect(a).toBe(b);
  });
});

describe("EntityStateStore.claim", () => {
  let db: ReturnType<typeof createFakeD1>;
  let store: EntityStateStore;
  const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };

  beforeEach(() => {
    db = createFakeD1();
    store = new EntityStateStore(db as any, 7);
  });

  it("returns isNew on first sight and mints a stable entity_id", async () => {
    const r = await store.claim(key, "fp1");
    expect(r.isNew).toBe(true);
    expect(r.unchanged).toBe(false);
    expect(r.entityId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the same entity_id on a second sight — the uuid must never churn", async () => {
    const first = await store.claim(key, "fp1");
    const second = await store.claim(key, "fp2");
    expect(second.entityId).toBe(first.entityId);
    expect(second.isNew).toBe(false);
  });

  it("reports unchanged when the fingerprint matches, so the poller skips the R2 write", async () => {
    await store.claim(key, "fp1");
    const again = await store.claim(key, "fp1");
    expect(again.unchanged).toBe(true);
  });

  it("reports changed and stores the new fingerprint when it differs", async () => {
    await store.claim(key, "fp1");
    const changed = await store.claim(key, "fp2");
    expect(changed.unchanged).toBe(false);
    const third = await store.claim(key, "fp2");
    expect(third.unchanged).toBe(true);
  });

  it("keys separately per secondary_id so the same post in two lists is two entities", async () => {
    const a = await store.claim({ ...key, entity: "content", secondaryId: "listA" }, "fp");
    const b = await store.claim({ ...key, entity: "content", secondaryId: "listB" }, "fp");
    expect(a.entityId).not.toBe(b.entityId);
  });

  it("keys separately per tenant", async () => {
    const other = new EntityStateStore(db as any, 8);
    const a = await store.claim(key, "fp");
    const b = await other.claim(key, "fp");
    expect(b.isNew).toBe(true);
    expect(b.entityId).not.toBe(a.entityId);
  });
});

// Final review I4: a caller (content.ts/x-users.ts) whose R2 pipeline send fails AFTER claim()
// already committed the new fingerprint calls this to undo that commit, so the row isn't
// permanently mistaken for "already sent, nothing changed" on the next attempt.
describe("EntityStateStore.rollbackFingerprint", () => {
  it("sets the stored fingerprint back to null without touching entity_id", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);
    const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };
    const { entityId } = await store.claim(key, "fp1");

    await store.rollbackFingerprint(key);

    const row = await store.get(key);
    expect(row?.fingerprint).toBeNull();
    expect(row?.entity_id).toBe(entityId);
  });

  // The whole point: after a rollback, re-claiming with the SAME fingerprint that was just
  // rolled back must report unchanged: false (a real hex digest never equals NULL), forcing a
  // resend on retry instead of the row being silently skipped forever.
  it("makes the next claim() with the SAME fingerprint report unchanged: false", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);
    const key = { entity: "content" as const, channelId: "c1", sourceId: "s1" };
    await store.claim(key, "fp1");

    await store.rollbackFingerprint(key);

    const retried = await store.claim(key, "fp1");
    expect(retried.unchanged).toBe(false);
  });

  it("does not affect is_follow/is_followed", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);
    const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };
    const { entityId } = await store.claim(key, "fp1");
    await store.setFollow(key, "is_follow", 1);

    await store.rollbackFingerprint(key);

    expect(await store.getFollowByEntityId(entityId)).toEqual({ is_follow: 1, is_followed: null });
  });
});

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
    const { entityId } = await store.claim(key, "fp");

    await store.setFollow(key, "is_follow", 1);

    expect(await store.getFollowByEntityId(entityId)).toEqual({ is_follow: 1, is_followed: null });
  });

  it("returns null for an unknown entity_id rather than throwing", async () => {
    const store = new EntityStateStore(createFakeD1() as any, 7);
    expect(await store.getFollowByEntityId("nope")).toBeNull();
  });
});
