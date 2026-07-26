import { describe, it, expect, vi } from "vitest";
import { XUsersService } from "../../src/services/x-users";
import userSchema from "../../../analytics/pipelines/user-stream-schema.json";
import eventSchema from "../../../analytics/pipelines/event-stream-schema.json";

const USER_SCHEMA_FIELD_NAMES = (userSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();
const EVENT_SCHEMA_FIELD_NAMES = (eventSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();

// Per-tenant D1 stand-in. Two statement shapes reach it, both through query() and never run() —
// run() discards result rows, which would throw away the authoritative id RETURNING hands back:
//   1. the probe SELECT  -> returns `existing`
//   2. the upsert INSERT -> returns one row, the way SQLite's RETURNING does
// The INSERT branch zips the bound params back onto the column list parsed out of the SQL, so a
// test can assert on what was actually written instead of on a canned echo. `returningOverride`
// simulates losing the probe->mint->upsert race: D1 keeps the winner's row, so RETURNING answers
// with an id this caller never minted.
function createMockTenantDb(
  existing: Record<string, unknown>[] = [],
  returningOverride?: Record<string, unknown>
) {
  const inserts: { sql: string; params: unknown[]; row: Record<string, unknown> }[] = [];
  const selects: { sql: string; params: unknown[] }[] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO user")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      inserts.push({ sql, params, row });
      if (returningOverride) return [returningOverride];
      const prior = existing[0];
      return [{
        // On conflict D1 keeps the stored row's id/created_at — DO UPDATE never touches them.
        id: prior ? prior.id : row.id,
        created_at: prior ? prior.created_at : row.created_at,
        is_follow: row.is_follow ?? prior?.is_follow ?? 0,
        is_followed: row.is_followed ?? prior?.is_followed ?? 0,
      }];
    }
    selects.push({ sql, params });
    return existing;
  });

  return {
    query,
    run: vi.fn(async () => ({ changes: 0 })),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
    _inserts: inserts,
    _selects: selects,
  };
}

function createMockEntityState() {
  return {
    ensureEntity: vi.fn().mockResolvedValue(undefined),
    setFollow: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    markSeen: vi.fn(),
  };
}

// A full `user` row as the poller would have left it in D1 — the merge source every webhook
// touch diffs against.
function priorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-existing",
    created_at: "2026-07-01T00:00:00.000Z",
    is_follow: 0,
    is_followed: 0,
    name: "Ann",
    username: "ann",
    verified_type: "blue",
    profile_image_url: "https://x/pic.jpg",
    description: "bio",
    followers_count: 500,
    following_count: 4,
    post_count: 10,
    listed_count: 2,
    like_count: 3,
    media_count: 0,
    ...overrides,
  };
}

// The DO UPDATE SET clause of the upsert that was actually issued — cut before RETURNING, whose
// column list mentions is_follow/is_followed and would otherwise satisfy a not.toContain check
// that is meant to be about the SET list.
function updateSetOf(sql: string): string {
  return sql.slice(sql.indexOf("DO UPDATE SET"), sql.indexOf("RETURNING"));
}

describe("XUsersService.upsertUser", () => {
  it("sends a complete row to the user pipeline — every schema column present, null when absent", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb() as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "u1", name: "Ada", username: "ada" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    // A spot-check of a few columns can't catch a writer that silently drops others — compare
    // the full key set against the R2 schema itself.
    expect(Object.keys(record).sort()).toEqual(USER_SCHEMA_FIELD_NAMES);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
  });

  it("writes the user through query(), never run() — run() would discard the RETURNING row", async () => {
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, { tenantId: 42, entityState: createMockEntityState() as any });

    await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(tenantDb._inserts).toHaveLength(1);
    expect(tenantDb._inserts[0].sql).toContain("ON CONFLICT(channel_id, source_user_id) DO UPDATE SET");
    expect(tenantDb._inserts[0].sql).toContain("RETURNING id, created_at, is_follow, is_followed");
    expect(tenantDb.run).not.toHaveBeenCalled();
  });

  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new XUsersService(null, { tenantId: 42, entityState: createMockEntityState() as any });

    await expect(service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X"))
      .rejects.toThrow(/tenantDb is required/);
  });

  it("returns the id D1 returned, not the one the probe minted", async () => {
    const tenantDb = createMockTenantDb([], { id: "winner-id", created_at: "2026-07-02T00:00:00.000Z", is_follow: 0, is_followed: 0 });
    const service = new XUsersService(tenantDb as any, { tenantId: 42, entityState: createMockEntityState() as any });

    const id = await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(id).toBe("winner-id");
  });

  // --- The probe -> mint -> upsert race (task-5 fix round I1, same class here) ---

  it("race: a concurrent writer's id comes back from RETURNING and is what the R2 copy and the entity_state mirror use", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState();
    // The probe saw nothing, so this call mints a fresh uuid — but between probe and upsert the
    // poller inserted the same (channel_id, source_user_id), so D1 keeps ITS id.
    const tenantDb = createMockTenantDb([], { id: "poller-won", created_at: "2026-07-02T00:00:00.000Z", is_follow: 0, is_followed: 1 });
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: entityState as any,
    });

    const returned = await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    const mintedId = tenantDb._inserts[0].row.id as string;
    expect(mintedId).not.toBe("poller-won"); // the probe really did propose a different id
    expect(returned).toBe("poller-won");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.id).toBe("poller-won");
    // …and the same id lands in entity_state, or flow's follow lookup would point at a uuid no
    // row in any store carries.
    expect(entityState.ensureEntity).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "u1" },
      "poller-won"
    );
    // is_follow/is_followed on the copy come from the post-write D1 row, not from a guess.
    expect(record.is_followed).toBe(1);
  });

  // --- Anti-clobber: the webhook knows three fields, D1 knows eleven ---

  it("does not null out D1-known columns in the R2 copy when the webhook payload omits them", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb([priorRow()]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    // The webhook knows only name/username — and changes the name, so the row genuinely changed.
    await service.upsertUser({ id: "x1", name: "NewName", username: "ann" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.name).toBe("NewName");       // the webhook's own field wins
    expect(record.followers_count).toBe(500);  // merged in from the D1 probe row (the truth)
    expect(record.post_count).toBe(10);
    expect(record.verified_type).toBe("blue");
    expect(record.description).toBe("bio");
    // Same guarantee on the D1 side: a column the webhook doesn't know must not be in the SET
    // list at all (461d039 wrote this as a per-column CASE WHEN).
    const set = updateSetOf(tenantDb._inserts[0].sql);
    expect(set).toContain("name = excluded.name");
    expect(set).not.toContain("followers_count");
    expect(set).not.toContain("verified_type");
  });

  it("keeps created_at from the existing D1 row instead of re-stamping it on every touch", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb([priorRow()]) as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "x1", name: "NewName" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.created_at).toBe("2026-07-01T00:00:00.000Z");
    expect(record.updated_at).not.toBe("2026-07-01T00:00:00.000Z");
  });

  // --- follow state ---

  it("writes is_follow to D1 and mirrors it into entity_state when the webhook reports a follow", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState();
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: entityState as any,
    });

    await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X", { is_follow: 1 });

    expect(tenantDb._inserts[0].row.is_follow).toBe(1);
    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1);
    expect(record.is_followed).toBe(0);
    // entity_state 是 flow userPropsFilter 的热读来源,必须同步写
    expect(entityState.ensureEntity).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "x1" },
      tenantDb._inserts[0].row.id
    );
    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "x1" }),
      "is_follow",
      1
    );
  });

  it("preserves the stored follow state when a plain webhook touch re-upserts an existing user", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb([priorRow({ is_follow: 1 })]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "x1", name: "Ann2" } as any, "chan1", "X");

    // 不带 follow 参数的 upsert 绝不能把已知的 is_follow 冲回 0
    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1);
    expect(updateSetOf(tenantDb._inserts[0].sql)).not.toContain("is_follow");
  });

  it("does not call setFollow when the caller reports no follow bits — but still creates the mirror row", async () => {
    const entityState = createMockEntityState();
    const service = new XUsersService(createMockTenantDb() as any, { tenantId: 42, entityState: entityState as any });

    await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

    expect(entityState.ensureEntity).toHaveBeenCalledTimes(1);
    expect(entityState.setFollow).not.toHaveBeenCalled();
  });

  it("does not assert is_followed from the poller's fixed-value mapping", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb() as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "u4", name: "Dee" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_followed).toBe(0);
  });

  // --- unchanged / forced send ---

  it("skips both the D1 write and the R2 send when nothing the webhook knows has changed", async () => {
    const pipelineUser = { send: vi.fn() };
    const tenantDb = createMockTenantDb([priorRow()]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X");

    expect(tenantDb._inserts).toHaveLength(0);
    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("still mirrors into entity_state on the unchanged path, using the existing D1 id", async () => {
    const entityState = createMockEntityState();
    const service = new XUsersService(createMockTenantDb([priorRow()]) as any, {
      tenantId: 42, entityState: entityState as any,
    });

    const id = await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X");

    expect(id).toBe("u-existing");
    expect(entityState.ensureEntity).toHaveBeenCalledWith(expect.anything(), "u-existing");
  });

  it("a follow argument forces the R2 send even when every profile field is identical", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    // The stored follow state already matches what the webhook reports, so nothing changed.
    const tenantDb = createMockTenantDb([priorRow({ is_follow: 1 })]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X", { is_follow: 1 });

    // No D1 write (the truth already says so) but R2, which has no column-wise update, still
    // gets a complete row carrying the follow state.
    expect(tenantDb._inserts).toHaveLength(0);
    expect(pipelineUser.send).toHaveBeenCalledTimes(1);
    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1);
    expect(record.followers_count).toBe(500);
  });

  it("a flipped follow bit counts as a change and reaches D1", async () => {
    const tenantDb = createMockTenantDb([priorRow({ is_follow: 1 })]);
    const service = new XUsersService(tenantDb as any, { tenantId: 42, entityState: createMockEntityState() as any });

    await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X", { is_follow: 0 });

    expect(tenantDb._inserts).toHaveLength(1);
    expect(tenantDb._inserts[0].row.is_follow).toBe(0);
    expect(updateSetOf(tenantDb._inserts[0].sql)).toContain("is_follow = excluded.is_follow");
  });

  // --- column mapping / raw_data ---

  // X names this field tweet_count; our propId is post_count. Resolving by propId alone
  // (an old `propId.includes("_count") ? public_metrics[propId]` heuristic) silently
  // dropped it, leaving the column null for every user.
  it("maps post_count from X's public_metrics.tweet_count via metadata", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser(
      { id: "u3", name: "Cy", public_metrics: { followers_count: 10, tweet_count: 1234, listed_count: 7 } } as any,
      "chan1",
      "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.post_count).toBe(1234);
    expect(record.listed_count).toBe(7);
    expect(record.following_count).toBeNull(); // omitted from the payload -> explicit null, not 0
    expect(tenantDb._inserts[0].row.post_count).toBe(1234);
  });

  // The column task 6's per-tenant migration exists for: a tenant DB older than verified_type
  // rejects this write with "no such column".
  it("writes verified_type to both stores when the payload carries it", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser({ id: "u7", name: "Gil", verified_type: "business" } as any, "chan1", "X");

    expect(tenantDb._inserts[0].row.verified_type).toBe("business");
    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.verified_type).toBe("business");
  });

  it("strips every column-mapped payload path from raw_data and keeps only the unmapped remainder", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUser(
      {
        id: "u1", name: "Ada", username: "ada", profile_image_url: "https://x/pic.jpg",
        location: "Earth", verified: true,
        public_metrics: { followers_count: 10, following_count: 2, tweet_count: 3, listed_count: 0, like_count: 0, media_count: 0 },
      } as any,
      "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    // consumed AND column-mapped — must not leak into raw_data.
    expect(raw).not.toHaveProperty("name");
    expect(raw).not.toHaveProperty("username");
    expect(raw.public_metrics).toEqual({});
    // unconsumed (no column at all) — must survive in raw_data.
    expect(raw.location).toBe("Earth");
    expect(raw.verified).toBe(true);
    // profile_image_url became a real column once the Users list was seen rendering it blank,
    // so it is consumed like any other mapped prop: it belongs in the column, not raw_data.
    expect(record.profile_image_url).toBe("https://x/pic.jpg");
    expect(raw).not.toHaveProperty("profile_image_url");
    // The same stripped remainder is what D1 stores, merged rather than replaced.
    expect(JSON.parse(tenantDb._inserts[0].row.raw_data as string)).toEqual(raw);
    expect(tenantDb._inserts[0].sql).toContain("raw_data = json_patch(user.raw_data, excluded.raw_data)");
  });
});

describe("XUsersService.upsertUserFromMetadata", () => {
  it("returns isNew true when the probe found no row and the write kept the proposed id", async () => {
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, { entityState: createMockEntityState() as any });

    const isNew = await service.upsertUserFromMetadata(
      { id: "u1", name: "Ada", username: "ada" },
      { source_user_id: "u1", name: "Ada", username: "ada", is_followed: 1 },
      "chan1", "X"
    );

    expect(isNew).toBe(true);
    expect(tenantDb._selects[0].params).toEqual(["chan1", "u1"]);
  });

  it("returns false when the user already exists in D1", async () => {
    const service = new XUsersService(createMockTenantDb([priorRow()]) as any, { entityState: createMockEntityState() as any });

    const isNew = await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada Updated" }, "chan1", "X"
    );

    expect(isNew).toBe(false);
  });

  // The poller counts "new followers" off this boolean — losing the race must not inflate it.
  it("race: returns false when RETURNING hands back an id this call did not mint", async () => {
    const tenantDb = createMockTenantDb([], { id: "webhook-won", created_at: "2026-07-02T00:00:00.000Z", is_follow: 0, is_followed: 1 });
    const entityState = createMockEntityState();
    const service = new XUsersService(tenantDb as any, { entityState: entityState as any });

    const isNew = await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada", is_followed: 1 }, "chan1", "X"
    );

    expect(isNew).toBe(false);
    expect(entityState.ensureEntity).toHaveBeenCalledWith(expect.anything(), "webhook-won");
  });

  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new XUsersService(null, { entityState: createMockEntityState() as any });

    await expect(
      service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1" }, "chan1", "X")
    ).rejects.toThrow(/tenantDb is required/);
  });

  it("sends a complete row to the user pipeline — every schema column present, null when absent", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb() as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada", is_followed: 1 }, "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(USER_SCHEMA_FIELD_NAMES);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
  });

  it("skips both the D1 write and the R2 send when the re-walked follower is byte-identical", async () => {
    const pipelineUser = { send: vi.fn() };
    const tenantDb = createMockTenantDb([priorRow({ is_followed: 1 })]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata(
      { id: "u1" },
      {
        source_user_id: "u1", name: "Ann", username: "ann", verified_type: "blue",
        profile_image_url: "https://x/pic.jpg", description: "bio",
        followers_count: 500, following_count: 4, post_count: 10, listed_count: 2, like_count: 3,
        is_followed: 1,
      },
      "chan1", "X"
    );

    expect(tenantDb._inserts).toHaveLength(0);
    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("writes every resolved userProps field to its matching column, not just name/username/is_followed", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    const resolvedProps = {
      source_user_id: "u1",
      description: "bio text",
      followers_count: 123,
      // resolveProps emits the metadata propId (post_count), never X's field name (tweet_count).
      post_count: 456,
    };

    await service.upsertUserFromMetadata({ id: "u1" }, resolvedProps, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.followers_count).toBe(123);
    expect(record.post_count).toBe(456);
    // description used to have no R2 column, so a resolved value was silently dropped and the
    // Users list rendered the cell blank. It is a real column in both stores now.
    expect(record.description).toBe("bio text");
    expect(tenantDb._inserts[0].row.description).toBe("bio text");
  });

  it("leaves an unresolved column-mapped field as null in the pipeline row, not omitted", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb() as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1" }, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.followers_count).toBeNull();
    expect(record.name).toBeNull();
  });

  it("takes is_followed from resolvedProps' fixed-value mapping (own:get-followers)", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");

    expect(tenantDb._inserts[0].row.is_followed).toBe(1);
    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_followed).toBe(1);
    expect(record.is_follow).toBe(0); // never known from this path; brand new -> defaults 0
  });

  it("preserves a previously stored is_follow when re-polling an existing follower", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const tenantDb = createMockTenantDb([priorRow({ is_follow: 1, is_followed: 1 })]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", followers_count: 999, is_followed: 1 }, "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1); // read back from D1, not reset to 0
    expect(updateSetOf(tenantDb._inserts[0].sql)).not.toContain("is_follow = excluded.is_follow");
  });

  // --- Critical 1 (previous round): the mirror must happen on THIS path too ---

  it("mirrors is_followed into entity_state in the same call as the D1 write (C1 regression)", async () => {
    const tenantDb = createMockTenantDb();
    const entityState = createMockEntityState();
    const service = new XUsersService(tenantDb as any, { tenantId: 42, entityState: entityState as any });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");

    expect(entityState.ensureEntity).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "u1" },
      tenantDb._inserts[0].row.id
    );
    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "u1" }),
      "is_followed",
      1
    );
  });

  it("mirrors is_follow into entity_state when resolvedProps provides it", async () => {
    const entityState = createMockEntityState();
    const service = new XUsersService(createMockTenantDb() as any, { tenantId: 42, entityState: entityState as any });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_follow: 1 }, "chan1", "X");

    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "u1" }),
      "is_follow",
      1
    );
  });

  it("mirrors the follow bit even when the D1 write and the R2 send are both skipped (unchanged)", async () => {
    const pipelineUser = { send: vi.fn() };
    const entityState = createMockEntityState();
    const tenantDb = createMockTenantDb([priorRow({ is_followed: 1 })]);
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: entityState as any,
    });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");

    expect(tenantDb._inserts).toHaveLength(0);
    expect(pipelineUser.send).not.toHaveBeenCalled();
    expect(entityState.setFollow).toHaveBeenCalledWith(expect.anything(), "is_followed", 1);
    expect(entityState.ensureEntity).toHaveBeenCalledWith(expect.anything(), "u-existing");
  });

  it("warns once, rather than silently, when no entityState is wired and the mirror cannot run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new XUsersService(createMockTenantDb() as any, { tenantId: 42 });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");
    await service.upsertUserFromMetadata({ id: "u2" }, { source_user_id: "u2", is_followed: 1 }, "chan1", "X");

    const mirrorWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes("user_follow_mirror_disabled"));
    expect(mirrorWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("strips consumed payload paths from raw_data, keeping the unmapped remainder", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockTenantDb() as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    await service.upsertUserFromMetadata(
      {
        id: "u1", name: "Ada", weird_field: "keep-me", profile_image_url: "https://x/pic.jpg",
        public_metrics: { followers_count: 10, following_count: 2, tweet_count: 3, listed_count: 0, like_count: 0, media_count: 0 },
      },
      { source_user_id: "u1", name: "Ada", followers_count: 10 },
      "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("name");
    expect(raw.public_metrics).toEqual({});
    expect(raw.weird_field).toBe("keep-me");
    expect(raw).not.toHaveProperty("profile_image_url");
  });

  it("throws when source_user_id is missing", async () => {
    const service = new XUsersService(createMockTenantDb() as any, { entityState: createMockEntityState() as any });
    await expect(
      service.upsertUserFromMetadata({}, {}, "chan1", "X")
    ).rejects.toThrow("upsertUserFromMetadata: missing source_user_id");
  });
});

// event has no D1 table (the 2026-07-26 restore brought back only `user` and `content`), so
// insertEvents stays R2-only and needs no tenant DB at all.
describe("XUsersService.insertEvents pipeline record", () => {
  // The X webhook payload nests counts under public_metrics, so the caller resolves
  // them via the event's metadata dataId mappings and hands them over already flat.
  const resolvedEventProps = { followers_count: 1234, following_count: 56, verified_type: "blue" };

  it("sends a complete row to the event pipeline — every schema column present, null when absent", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(null, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

    await service.insertEvents([{
      userId: "u1", channelId: "chan1", eventType: "follow.follow",
      rawData: { id: "u1" }, eventProps: resolvedEventProps,
    }]);

    const [[record]] = pipelineEvent.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(EVENT_SCHEMA_FIELD_NAMES);
    expect(record.tenant_id).toBe(42);
  });

  it("writes caller-resolved event props onto the pipeline record", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(null, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      eventTime: "2026-07-24T10:00:00.000Z",
      rawData: { id: "u1", verified_type: "blue", public_metrics: { followers_count: 1234, following_count: 56 } },
      eventProps: resolvedEventProps,
    }]);

    const [[record]] = pipelineEvent.send.mock.calls[0];
    expect(record.followers_count).toBe(1234);
    expect(record.following_count).toBe(56);
    expect(record.verified_type).toBe("blue");
    expect(record.tenant_id).toBe(42);
    expect(record.event_type).toBe("follow.follow");
  });

  it("omits props the caller could not resolve as explicit null, never leaves them absent", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(null, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      rawData: { id: "u1" },
      eventProps: { followers_count: 7, following_count: undefined, verified_type: null },
    }]);

    const [[record]] = pipelineEvent.send.mock.calls[0];
    expect(record.followers_count).toBe(7);
    expect(record.following_count).toBeNull();
    expect(record.verified_type).toBeNull();
  });

  it("strips exactly the given consumedPaths from raw_data, keeping everything else", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(null, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      rawData: { id: "u1", public_metrics: { followers_count: 1234 }, weird_field: 1 },
      eventProps: { followers_count: 1234 },
      consumedPaths: ["public_metrics.followers_count"],
    }]);

    const [[record]] = pipelineEvent.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).toHaveProperty("weird_field", 1);
    expect(raw).toHaveProperty("id", "u1");
    expect(raw.public_metrics).toEqual({});
  });

  it("falls back to storing the entire payload and warns once when consumedPaths is omitted", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new XUsersService(null, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

    const rawData = { id: "u1", public_metrics: { followers_count: 1234 } };
    await service.insertEvents([{
      userId: "u1", channelId: "chan1", eventType: "follow.follow", rawData, eventProps: resolvedEventProps,
    }]);

    const [[record]] = pipelineEvent.send.mock.calls[0];
    expect(JSON.parse(record.raw_data as string)).toEqual(rawData);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // --- Minor 2 (task-5 fix round): a missing pipeline used to drop events silently ---

  it("warns and drops events when no pipeline/tenantId is configured, rather than silently discarding them", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new XUsersService(null);

    await service.insertEvents([{ userId: "u1", channelId: "chan1", eventType: "follow.follow", rawData: {} }]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("insertEvents_no_pipeline");
    warnSpy.mockRestore();
  });

  it("does not warn for an empty events array with no pipeline configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new XUsersService(null);

    await service.insertEvents([]);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// A failed R2 send is logged and swallowed, never rolled back: D1 already committed, and the
// fingerprint machinery this file used to depend on (claim/rollbackFingerprint) is gone with it.
describe("R2 send failure does not fail the caller", () => {
  it("upsertUser still returns the D1 id when the pipeline send rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pipelineUser = { send: vi.fn().mockRejectedValue(new Error("transient R2 error")) };
    const tenantDb = createMockTenantDb();
    const service = new XUsersService(tenantDb as any, {
      pipelineUser: pipelineUser as any, tenantId: 42, entityState: createMockEntityState() as any,
    });

    const id = await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(id).toBe(tenantDb._inserts[0].row.id);
    expect(errorSpy.mock.calls[0][0]).toContain("pipeline_user_error");
    errorSpy.mockRestore();
  });
});
