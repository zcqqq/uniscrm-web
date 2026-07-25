import { describe, it, expect, vi, afterEach } from "vitest";
import { XUsersService } from "../../src/services/x-users";
import userSchema from "../../../analytics/pipelines/user-stream-schema.json";
import eventSchema from "../../../analytics/pipelines/event-stream-schema.json";

const USER_SCHEMA_FIELD_NAMES = (userSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();
const EVENT_SCHEMA_FIELD_NAMES = (eventSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();

const R2_ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_CATALOG_TOKEN: "t" };

// Stubs the global fetch getUserBySource (via shared/r2-sql.ts's r2Query) goes through, so
// upsertUser's read-modify-write path (task-5 fix round, Important 2) can be exercised without
// a real R2 SQL endpoint. Mirrors r2-entities.test.ts's stubR2 helper.
function stubR2(rows: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

function createMockEntityState(overrides: Partial<{ entityId: string; isNew: boolean; unchanged: boolean }> = {}) {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: true, unchanged: false, ...overrides }),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn().mockResolvedValue(undefined),
    rollbackFingerprint: vi.fn().mockResolvedValue(undefined),
  };
}

// A lightweight in-memory stand-in for the real D1-backed EntityStateStore — used only for the
// cross-method fingerprint-agreement test below, where a canned mock can't prove the two
// writers actually compute the same fingerprint for the same data; a real (if tiny) claim/get/
// setFollow implementation can.
function createFakeEntityState() {
  const rows = new Map<string, { entity_id: string; fingerprint: string; is_follow: 0 | 1; is_followed: 0 | 1 }>();
  const k = (key: { entity: string; channelId: string; secondaryId?: string; sourceId: string }) =>
    `${key.entity}|${key.channelId}|${key.secondaryId ?? ""}|${key.sourceId}`;
  return {
    claim: vi.fn(async (key: any, fingerprint: string) => {
      const id = k(key);
      const existing = rows.get(id);
      if (!existing) {
        const entityId = crypto.randomUUID();
        rows.set(id, { entity_id: entityId, fingerprint, is_follow: 0, is_followed: 0 });
        return { entityId, isNew: true, unchanged: false };
      }
      if (existing.fingerprint === fingerprint) {
        return { entityId: existing.entity_id, isNew: false, unchanged: true };
      }
      existing.fingerprint = fingerprint;
      return { entityId: existing.entity_id, isNew: false, unchanged: false };
    }),
    get: vi.fn(async (key: any) => {
      const existing = rows.get(k(key));
      return existing
        ? { entity_id: existing.entity_id, fingerprint: existing.fingerprint, is_follow: existing.is_follow, is_followed: existing.is_followed }
        : null;
    }),
    setFollow: vi.fn(async (key: any, field: "is_follow" | "is_followed", value: 0 | 1) => {
      const existing = rows.get(k(key));
      if (existing) existing[field] = value;
    }),
    rollbackFingerprint: vi.fn(async (key: any) => {
      const existing = rows.get(k(key));
      if (existing) existing.fingerprint = null as any;
    }),
  };
}

describe("XUsersService.upsertUser", () => {
  it("sends a complete row to the user pipeline — every schema column present, null when absent", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u1", name: "Ada", username: "ada" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    // I4 (content.ts precedent): a spot-check of a few columns can't catch a writer that
    // silently drops others — compare the full key set against the R2 schema itself.
    expect(Object.keys(record).sort()).toEqual(USER_SCHEMA_FIELD_NAMES);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
  });

  // --- The is_follow/is_followed bug this task fixes ---

  it("sends is_follow = 1 on the same full row when the webhook reports a follow (new user, no R2 read needed)", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: true, unchanged: false }),
      get: vi.fn().mockResolvedValue(null), // isNew — nothing stored yet
      setFollow: vi.fn().mockResolvedValue(undefined),
    };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X", { is_follow: 1 });

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1);
    expect(record.is_followed).toBe(0);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
    // entity_state 是 flow userPropsFilter 的热读来源,必须同步写
    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "x1" }),
      "is_follow",
      1
    );
  });

  it("preserves the previously stored follow state when a plain poll re-upserts an existing user", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
      get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 1, is_followed: 0 }),
      setFollow: vi.fn(),
    };
    // Existing user (get() returns a row) -> read-modify-write needs r2Env; no prior R2 row
    // matters for this assertion, so an empty result is enough.
    stubR2([]);
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 }, R2_ENV as any);

    await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    // 不带 follow 参数的 upsert 绝不能把已知的 is_follow 冲回 0
    expect(record.is_follow).toBe(1);
  });

  it("skips the pipeline when entity_state reports unchanged", async () => {
    const pipelineUser = { send: vi.fn() };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: true }),
      get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 0 }),
      setFollow: vi.fn(),
    };
    stubR2([]);
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 }, R2_ENV as any);

    await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("calls entity_state.get exactly once — no redundant follow-state lookup", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u5", name: "Eve" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(0);
    expect(record.is_followed).toBe(0);
    expect(entityState.get).toHaveBeenCalledTimes(1);
  });

  it("returns the claimed entityId", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ entityId: "u-abc" });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    const id = await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(id).toBe("u-abc");
  });

  // X names this field tweet_count; our propId is post_count. Resolving by propId alone
  // (an old `propId.includes("_count") ? public_metrics[propId]` heuristic) silently
  // dropped it, leaving the column null for every user.
  it("maps post_count from X's public_metrics.tweet_count via metadata", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser(
      { id: "u3", name: "Cy", public_metrics: { followers_count: 10, tweet_count: 1234, listed_count: 7 } } as any,
      "chan1",
      "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.post_count).toBe(1234);
    expect(record.listed_count).toBe(7);
    expect(record.following_count).toBeNull(); // omitted from the payload -> explicit null, not 0
  });

  // UserMetadata_X's own:get-followers entry carries `{ propId: "is_followed", value: 1 }`,
  // which describes that poller's context. A webhook user (no `follow` argument) must not
  // inherit it.
  it("does not assert is_followed from the poller's fixed-value mapping", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u4", name: "Dee" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_followed).toBe(0);
  });

  it("strips consumed payload paths from raw_data but keeps unmapped and mapped-but-columnless fields", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

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
    // Important 1 (task-5 fix round): profile_image_url has a dataId in X_USER_MAPPINGS but no
    // R2 `user` column — treating it as "consumed" would destroy it with nowhere else to land.
    expect(raw.profile_image_url).toBe("https://x/pic.jpg");
  });

  // --- Important 2 (task-5 fix round): read-modify-write for existing users ---

  describe("read-modify-write for an existing user", () => {
    // task-5 fix round 2: a caller with no pipeline at all (tenantId set, but no pipelineUser
    // and no r2Env — e.g. it only wants the stable entity id / follow-state bookkeeping) must
    // not be blocked by the r2Env requirement, which only exists to protect a pipeline WRITE.
    // Regression the re-reviewer caught in round 1: the throw fired before claim()/setFollow()
    // ever ran, so entity_state bookkeeping — which must never stop — stopped too.
    it("does not throw and still runs claim/setFollow when no pipeline is configured at all", async () => {
      const entityState = {
        claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
        get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 0 }),
        setFollow: vi.fn().mockResolvedValue(undefined),
      };
      // tenantId set, but no pipelineUser and no r2Env.
      const service = new XUsersService(entityState as any, { tenantId: 42 });

      const id = await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X", { is_follow: 1 });

      expect(id).toBe("u-uuid");
      expect(entityState.claim).toHaveBeenCalledTimes(1);
      expect(entityState.setFollow).toHaveBeenCalledWith(
        expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "x1" }),
        "is_follow",
        1
      );
    });

    it("merges the poller's last-known metric columns into the webhook's row instead of nulling them out", async () => {
      const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
      const entityState = {
        claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
        get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 1 }),
        setFollow: vi.fn(),
      };
      // The poller previously wrote a full row with real metric columns; the webhook only
      // knows name/username (and here changes the name, so the merged row is genuinely new).
      stubR2([{ name: "OldName", username: "ann", followers_count: 500, post_count: 10, listed_count: 2, like_count: 3, media_count: 0, following_count: 4, verified_type: "blue" }]);
      const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 }, R2_ENV as any);

      await service.upsertUser({ id: "x1", name: "NewName", username: "ann" } as any, "chan1", "X");

      const [[record]] = pipelineUser.send.mock.calls[0];
      expect(record.name).toBe("NewName"); // webhook's own field wins
      expect(record.followers_count).toBe(500); // carried over from the prior R2 row
      expect(record.post_count).toBe(10);
      expect(record.verified_type).toBe("blue");
    });

    // task-5 fix round 2: a pipeline write without the merge would null out every metric
    // column the poller last populated — a real misconfiguration, so it must still throw.
    // But claim()/setFollow() must run first (see the two tests in the next describe block):
    // entity_state bookkeeping must never stop just because R2 wiring is incomplete.
    it("throws when a pipeline is configured but r2Env is missing — after claim/setFollow still ran", async () => {
      const entityState = {
        claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
        get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 0 }),
        setFollow: vi.fn().mockResolvedValue(undefined),
      };
      // No third (r2Env) constructor argument.
      const service = new XUsersService(entityState as any, { pipelineUser: { send: vi.fn() } as any, tenantId: 42 });

      let error: Error | undefined;
      try {
        await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X", { is_follow: 1 });
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message).toMatch(/r2Env/);
      expect(error?.message).toMatch(/merge/);
      expect(entityState.claim).toHaveBeenCalledTimes(1);
      expect(entityState.setFollow).toHaveBeenCalledWith(expect.anything(), "is_follow", 1);
    });

    it("falls back to the webhook's own fields (no throw) when the prior R2 row hasn't landed yet", async () => {
      const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
      const entityState = {
        claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
        get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 0 }),
        setFollow: vi.fn(),
      };
      stubR2([]); // R2 pipeline hasn't ingested a row for this user yet — eventual consistency
      const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 }, R2_ENV as any);

      await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X");

      const [[record]] = pipelineUser.send.mock.calls[0];
      expect(record.name).toBe("Ann");
      expect(record.followers_count).toBeNull();
    });
  });

  describe("no read for a new user", () => {
    it("sends explicit nulls for unknown columns without ever reading R2", async () => {
      const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
      const entityState = createMockEntityState({ isNew: true, unchanged: false }); // get() -> null
      // No r2Env at all — if the code attempted a read, this fetch stub would blow up the test.
      const fetchMock = vi.fn().mockImplementation(() => {
        throw new Error("should not have made an R2 request for a new user");
      });
      vi.stubGlobal("fetch", fetchMock);
      const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

      await service.upsertUser({ id: "u6", name: "Fay" } as any, "chan1", "X");

      const [[record]] = pipelineUser.send.mock.calls[0];
      expect(record.followers_count).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // Proves the actual invariant Important 2 is after: given the same underlying data, a poller
  // write and a later webhook touch compute the SAME fingerprint, so the second write is a
  // true no-op. A canned mock can't prove this (it would just echo back whatever "unchanged" we
  // told it to return) — this uses a tiny real claim/get/setFollow implementation instead.
  it("a poller write and a same-data webhook touch agree on the fingerprint — the second call sends nothing", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createFakeEntityState();
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 }, R2_ENV as any);

    await service.upsertUserFromMetadata(
      { id: "u1" },
      {
        source_user_id: "u1", name: "Ada", username: "ada",
        followers_count: 500, following_count: 10, post_count: 3, listed_count: 1, like_count: 2, media_count: 0,
        is_followed: 1,
      },
      "chan1", "X"
    );
    expect(pipelineUser.send).toHaveBeenCalledTimes(1);
    const [[pollerRecord]] = pipelineUser.send.mock.calls[0];

    // The webhook's R2 read must see exactly what the poller just wrote, for a realistic merge.
    stubR2([pollerRecord]);
    pipelineUser.send.mockClear();

    await service.upsertUser({ id: "u1", name: "Ada", username: "ada" } as any, "chan1", "X");

    expect(pipelineUser.send).not.toHaveBeenCalled();
  });
});

describe("XUsersService.upsertUserFromMetadata", () => {
  it("claims an entity_state id and returns isNew from the claim", async () => {
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any);

    const rawItem = { id: "u1", name: "Ada", username: "ada" };
    const resolvedProps = { source_user_id: "u1", name: "Ada", username: "ada", is_followed: 1 };

    const isNew = await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(entityState.claim).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "u1" },
      expect.any(String)
    );
  });

  it("returns false when entity_state reports an existing (non-new) entity", async () => {
    const entityState = createMockEntityState({ isNew: false, unchanged: false });
    const service = new XUsersService(entityState as any);

    const isNew = await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada Updated" }, "chan1", "X"
    );

    expect(isNew).toBe(false);
  });

  it("sends a complete row to the user pipeline — every schema column present, null when absent", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada", is_followed: 1 }, "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(USER_SCHEMA_FIELD_NAMES);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
  });

  it("does not send to the pipeline when entity_state reports the fingerprint unchanged", async () => {
    const pipelineUser = { send: vi.fn() };
    const entityState = createMockEntityState({ isNew: false, unchanged: true });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", name: "Ada" }, "chan1", "X"
    );

    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("writes every resolved userProps field to its matching R2 column, not just name/username/is_followed", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    const resolvedProps = {
      source_user_id: "u1",
      description: "bio text", // no R2 column — must not appear as a column
      followers_count: 123,
      // resolveProps emits the metadata propId (post_count), never X's field name
      // (tweet_count) — the R2 column has to match the propId or the value is dropped.
      post_count: 456,
    };

    await service.upsertUserFromMetadata({ id: "u1" }, resolvedProps, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.followers_count).toBe(123);
    expect(record.post_count).toBe(456);
    expect(record).not.toHaveProperty("description");
  });

  it("leaves an unresolved column-mapped field as null in the pipeline row, not omitted", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1" }, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.followers_count).toBeNull();
    expect(record.name).toBeNull();
  });

  it("takes is_followed from resolvedProps' fixed-value mapping (own:get-followers)", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState({ isNew: true }) as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_followed).toBe(1);
    expect(record.is_follow).toBe(0); // never known from this path; brand new -> defaults 0
  });

  it("preserves a previously stored is_follow when re-polling an existing (non-new) follower", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
      get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 1, is_followed: 1 }),
      setFollow: vi.fn(),
    };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", followers_count: 999, is_followed: 1 }, "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1); // read back from entity_state, not reset to 0
  });

  // --- Critical 1 (task-5 fix round): the headline bug survived on this exact path ---

  it("mirrors is_followed into entity_state via setFollow — without this, the next webhook touch reads NULL and wipes R2's is_followed", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X"
    );

    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "u1" }),
      "is_followed",
      1
    );
  });

  it("mirrors is_follow into entity_state via setFollow when resolvedProps provides it", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", is_follow: 1 }, "chan1", "X"
    );

    expect(entityState.setFollow).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "u1" }),
      "is_follow",
      1
    );
  });

  it("does not call setFollow when resolvedProps carries neither follow field", async () => {
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any);

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", name: "Ada" }, "chan1", "X");

    expect(entityState.setFollow).not.toHaveBeenCalled();
  });

  it("mirrors the follow bit into entity_state even when the pipeline write is skipped (unchanged)", async () => {
    const pipelineUser = { send: vi.fn() };
    const entityState = createMockEntityState({ isNew: false, unchanged: true });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", is_followed: 1 }, "chan1", "X");

    expect(entityState.setFollow).toHaveBeenCalledWith(expect.anything(), "is_followed", 1);
    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("strips consumed payload paths from raw_data via consumedPaths, keeping unmapped and mapped-but-columnless fields", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

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
    // Important 1: profile_image_url has a dataId but no R2 column — must survive.
    expect(raw.profile_image_url).toBe("https://x/pic.jpg");
  });

  it("throws when source_user_id is missing", async () => {
    const service = new XUsersService(createMockEntityState() as any);
    await expect(
      service.upsertUserFromMetadata({}, {}, "chan1", "X")
    ).rejects.toThrow("upsertUserFromMetadata: missing source_user_id");
  });
});

describe("XUsersService.insertEvents pipeline record", () => {
  // The X webhook payload nests counts under public_metrics, so the caller resolves
  // them via the event's metadata dataId mappings and hands them over already flat.
  const resolvedEventProps = { followers_count: 1234, following_count: 56, verified_type: "blue" };

  it("sends a complete row to the event pipeline — every schema column present, null when absent", async () => {
    const pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

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
    const service = new XUsersService(createMockEntityState() as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

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
    const service = new XUsersService(createMockEntityState() as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

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
    const service = new XUsersService(createMockEntityState() as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

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
    const service = new XUsersService(createMockEntityState() as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });

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
    const service = new XUsersService(createMockEntityState() as any);

    await service.insertEvents([{ userId: "u1", channelId: "chan1", eventType: "follow.follow", rawData: {} }]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("insertEvents_no_pipeline");
    warnSpy.mockRestore();
  });

  it("does not warn for an empty events array with no pipeline configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new XUsersService(createMockEntityState() as any);

    await service.insertEvents([]);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// Final review I4: both upsertUser and upsertUserFromMetadata call entityState.claim() (which
// commits the new fingerprint durably) BEFORE the pipelineUser send. The old sendUserRecord just
// logged and swallowed a failed send — leaving the fingerprint claiming success while the row
// never reached R2, so the next poll/webhook touch computes the same fingerprint, sees it already
// matches, and never resends (content.ts's identical bug — see content.test.ts's mirror suite).
// The fix rolls the fingerprint back to NULL on a failed send, so the next claim() for that key
// is guaranteed to report unchanged: false.
describe("pipeline send failure rolls back the entity_state fingerprint (final review I4)", () => {
  it("upsertUser: rolls back the claimed key when the pipeline send rejects", async () => {
    const entityState = createMockEntityState({ entityId: "u-uuid", isNew: true, unchanged: false });
    const pipelineUser = { send: vi.fn().mockRejectedValue(new Error("transient R2 error")) };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(pipelineUser.send).toHaveBeenCalledTimes(1);
    expect(entityState.rollbackFingerprint).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "u1" }
    );
  });

  it("upsertUser: does NOT roll back when the send succeeds", async () => {
    const entityState = createMockEntityState({ entityId: "u-uuid", isNew: true, unchanged: false });
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u1", name: "Ada" } as any, "chan1", "X");

    expect(entityState.rollbackFingerprint).not.toHaveBeenCalled();
  });

  it("upsertUserFromMetadata: rolls back the claimed key when the pipeline send rejects", async () => {
    const entityState = createMockEntityState({ entityId: "u-uuid", isNew: true, unchanged: false });
    const pipelineUser = { send: vi.fn().mockRejectedValue(new Error("transient R2 error")) };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata({ id: "u1" }, { source_user_id: "u1", followers_count: 10 }, "chan1", "X");

    expect(entityState.rollbackFingerprint).toHaveBeenCalledWith(
      { entity: "user", channelId: "chan1", sourceId: "u1" }
    );
  });

  // Integration-level proof (real EntityStateStore, not a mock that just echoes calls back):
  // after a failed send, the SAME logical write retried later must report unchanged: false and
  // actually reach the pipeline again.
  it("a failed send leaves the next call for the same key reporting unchanged: false and resending", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const keyOf = (p: unknown[]) => p.slice(0, 5).join("\x1f");
    const fakeDb = {
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
                    is_follow: null, is_followed: null,
                  });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET fingerprint = NULL")) {
                  const k = [params[1], params[2], params[3], params[4], params[5]].join("\x1f");
                  const row = rows.get(k);
                  if (row) row.fingerprint = null;
                  return { meta: { changes: row ? 1 : 0 } };
                }
                if (sql.includes("UPDATE entity_state SET fingerprint")) {
                  const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                  const row = rows.get(k);
                  if (row) row.fingerprint = params[0];
                  return { meta: { changes: row ? 1 : 0 } };
                }
                if (sql.includes("UPDATE entity_state SET is_follow") || sql.includes("UPDATE entity_state SET is_followed")) {
                  return { meta: { changes: 1 } };
                }
                throw new Error(`fake D1: unhandled run() for ${sql}`);
              },
              async first() {
                return rows.get(keyOf(params)) ?? null;
              },
            };
          },
        };
      },
    };

    const { EntityStateStore } = await import("../../src/services/entity-state");
    const entityState = new EntityStateStore(fakeDb as any, 42);

    const pipelineUser = { send: vi.fn() };
    pipelineUser.send.mockRejectedValueOnce(new Error("transient R2 error"));
    pipelineUser.send.mockResolvedValueOnce(undefined);
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    const resolvedProps = { source_user_id: "u1", followers_count: 10 };

    await service.upsertUserFromMetadata({ id: "u1" }, resolvedProps, "chan1", "X");
    expect(pipelineUser.send).toHaveBeenCalledTimes(1);

    // Without the rollback, claim() would see the same fingerprint already stored and report
    // unchanged: true, so the pipeline would never be called again.
    await service.upsertUserFromMetadata({ id: "u1" }, resolvedProps, "chan1", "X");
    expect(pipelineUser.send).toHaveBeenCalledTimes(2);
  });
});
