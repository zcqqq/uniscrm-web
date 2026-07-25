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

function createMockEntityState(overrides: Partial<{ entityId: string; isNew: boolean; unchanged: boolean }> = {}) {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: true, unchanged: false, ...overrides }),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn().mockResolvedValue(undefined),
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

  it("sends is_follow = 1 on the same full row when the webhook reports a follow", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: true, unchanged: false }),
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

  it("preserves the previously stored follow state when a plain poll re-upserts the user", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = {
      claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
      get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 1, is_followed: 0 }),
      setFollow: vi.fn(),
    };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

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
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

    expect(pipelineUser.send).not.toHaveBeenCalled();
  });

  it("does not preserve a stored is_follow when isNew — a brand-new entity_state row has nothing stored yet", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUser({ id: "u5", name: "Eve" } as any, "chan1", "X");

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(0);
    expect(record.is_followed).toBe(0);
    // isNew is guaranteed to have nothing stored — no point spending a D1 round trip on it.
    expect(entityState.get).not.toHaveBeenCalled();
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

  it("strips consumed payload paths from raw_data but keeps unmapped fields", async () => {
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
    // consumed (mapped to a column or the id/name/username/profile_image_url identity
    // fields) — must not leak the entire payload into raw_data.
    expect(raw).not.toHaveProperty("name");
    expect(raw).not.toHaveProperty("username");
    expect(raw).not.toHaveProperty("profile_image_url");
    expect(raw.public_metrics).toEqual({});
    // unconsumed — no column for these, so they must survive in raw_data.
    expect(raw.location).toBe("Earth");
    expect(raw.verified).toBe(true);
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
    };
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      { id: "u1" }, { source_user_id: "u1", followers_count: 999, is_followed: 1 }, "chan1", "X"
    );

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(record.is_follow).toBe(1); // read back from entity_state, not reset to 0
  });

  it("strips consumed payload paths from raw_data via consumedPaths, keeping unmapped fields", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(createMockEntityState() as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    await service.upsertUserFromMetadata(
      {
        id: "u1", name: "Ada", weird_field: "keep-me",
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

  it("does nothing when no pipeline/tenantId is configured", async () => {
    const service = new XUsersService(createMockEntityState() as any);
    await expect(
      service.insertEvents([{ userId: "u1", channelId: "chan1", eventType: "follow.follow", rawData: {} }])
    ).resolves.toBeUndefined();
  });
});

describe("XUsersService.upsertUsers (legacy bulk path)", () => {
  it("sends a complete row per user and reports new ids via the queue", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, queue: queue as any, tenantId: 42 });

    await service.upsertUsers([{ id: "u1", name: "Ada", username: "ada" } as any]);

    const [[record]] = pipelineUser.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(USER_SCHEMA_FIELD_NAMES);
    expect(queue.sendBatch).toHaveBeenCalledWith([{ body: { user_id: "u1", username: "ada" } }]);
  });

  it("does not queue a user entity_state reports as not new", async () => {
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: false, unchanged: false });
    const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, queue: queue as any, tenantId: 42 });

    await service.upsertUsers([{ id: "u1", name: "Ada", username: "ada" } as any]);

    expect(queue.sendBatch).not.toHaveBeenCalled();
  });
});
