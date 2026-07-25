import { describe, it, expect, vi, beforeEach } from "vitest";
import { XUsersService } from "../../src/services/x-users";

function createMockTenantDb() {
  return {
    query: vi.fn(),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("XUsersService.upsertUserFromMetadata", () => {
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let pipelineUser: { send: ReturnType<typeof vi.fn> };
  let service: XUsersService;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    service = new XUsersService(tenantDb as any, { pipelineUser: pipelineUser as any, tenantId: 42 });
  });

  it("inserts a new user and returns true when none exists for channel+source_user_id", async () => {
    tenantDb.query.mockResolvedValue([]); // no existing row
    const rawItem = { id: "u1", name: "Ada", username: "ada" };
    const resolvedProps = { source_user_id: "u1", name: "Ada", is_followed: 1 };

    const isNew = await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user"),
      expect.arrayContaining(["chan1", "u1", "X"])
    );
    const rawDataArg = tenantDb.run.mock.calls[0][1].find((p: unknown) => typeof p === "string" && p.includes("\"id\":\"u1\""));
    expect(rawDataArg).toBe(JSON.stringify(rawItem));
  });

  it("updates and returns false when a user already exists for channel+source_user_id", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid" }]);
    const rawItem = { id: "u1", name: "Ada Updated" };
    const resolvedProps = { source_user_id: "u1", name: "Ada Updated" };

    const isNew = await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(false);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(channel_id, source_user_id) DO UPDATE SET"),
      expect.arrayContaining(["existing-uuid"])
    );
  });

  it("uses an atomic ON CONFLICT upsert (collision-safe) rather than a bare INSERT that could throw on collision", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1", name: "Ada" };
    const resolvedProps = { source_user_id: "u1", name: "Ada" };

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const sql = tenantDb.run.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO user");
    expect(sql).toContain("ON CONFLICT(channel_id, source_user_id) DO UPDATE SET");
  });

  it("omits unresolved fields from the pipeline record instead of defaulting them", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = { source_user_id: "u1" }; // no name, no username, no is_followed

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const record = pipelineUser.send.mock.calls[0][0][0];
    expect(record).not.toHaveProperty("name");
    expect(record).not.toHaveProperty("is_followed");
    expect(record.source_user_id).toBe("u1");
  });

  it("writes profile_image_url to its dedicated D1 column", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = { source_user_id: "u1", profile_image_url: "https://example.com/pic.jpg" };

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["https://example.com/pic.jpg"])
    );
  });

  it("writes every userProps-resolved field to its matching D1 column, not just name/username/is_followed", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = {
      source_user_id: "u1",
      description: "bio text",
      followers_count: 123,
      tweet_count: 456,
    };

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const [sql, params] = tenantDb.run.mock.calls[0];
    expect(sql).toContain("description");
    expect(sql).toContain("followers_count");
    expect(sql).toContain("tweet_count");
    expect(params).toEqual(expect.arrayContaining(["bio text", 123, 456]));
  });

  it("omits an unresolved column-mapped field from the INSERT/UPDATE entirely, rather than writing null", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = { source_user_id: "u1" }; // no description resolved

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const [sql] = tenantDb.run.mock.calls[0];
    expect(sql).not.toContain("description");
  });

  it("sends only isInsight-marked props to the pipeline record, never free-text fields like description", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = {
      source_user_id: "u1",
      description: "some free-text bio that should never reach R2",
      profile_image_url: "https://example.com/pic.jpg",
      followers_count: 42, // isInsight: true in PROPS
      is_followed: 1, // isInsight: true in PROPS
    };

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const record = pipelineUser.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(42);
    expect(record.is_followed).toBe(1);
    expect(record).not.toHaveProperty("description");
    expect(record).not.toHaveProperty("profile_image_url");
  });
});

describe("XUsersService.upsertUser (regression: no more zero-defaulting)", () => {
  it("omits a missing count field from the pipeline record instead of writing 0", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([]);
    tenantDb.run.mockResolvedValue({ changes: 1 });
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(tenantDb as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    // public_metrics deliberately omits following_count
    await service.upsertUser(
      { id: "u2", name: "Bea", public_metrics: { followers_count: 500 } } as any,
      "chan1",
      "X"
    );

    const record = pipelineUser.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(500);
    expect(record).not.toHaveProperty("following_count");
  });
});

describe("XUsersService.insertEvents pipeline record", () => {
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let pipelineEvent: { send: ReturnType<typeof vi.fn> };
  let service: XUsersService;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    tenantDb.batch.mockResolvedValue([]);
    pipelineEvent = { send: vi.fn().mockResolvedValue(undefined) };
    service = new XUsersService(tenantDb as any, { pipelineEvent: pipelineEvent as any, tenantId: 42 });
  });

  // The X webhook payload nests counts under public_metrics, so the caller resolves
  // them via the event's metadata dataId mappings and hands them over already flat.
  const resolvedEventProps = { followers_count: 1234, following_count: 56, verified_type: "blue" };

  it("writes caller-resolved event props onto the pipeline record", async () => {
    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      eventTime: "2026-07-24T10:00:00.000Z",
      rawData: { id: "u1", verified_type: "blue", public_metrics: { followers_count: 1234, following_count: 56 } },
      eventProps: resolvedEventProps,
    }]);

    const record = pipelineEvent.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(1234);
    expect(record.following_count).toBe(56);
    expect(record.verified_type).toBe("blue");
    expect(record.tenant_id).toBe(42);
    expect(record.event_type).toBe("follow.follow");
  });

  it("does not reach into the raw payload itself — nested counts stay unread without eventProps", async () => {
    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      rawData: { id: "u1", public_metrics: { followers_count: 1234 } },
    }]);

    const record = pipelineEvent.send.mock.calls[0][0][0];
    expect(record).not.toHaveProperty("followers_count");
    expect(record).not.toHaveProperty("public_metrics");
  });

  it("omits props the caller could not resolve rather than writing null/0", async () => {
    await service.insertEvents([{
      userId: "u1",
      channelId: "chan1",
      eventType: "follow.follow",
      rawData: { id: "u1" },
      eventProps: { followers_count: 7, following_count: undefined, verified_type: null },
    }]);

    const record = pipelineEvent.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(7);
    expect(record).not.toHaveProperty("following_count");
    expect(record).not.toHaveProperty("verified_type");
  });

  it("still stores the untouched raw payload in D1 (full payload never widened)", async () => {
    const rawData = { id: "u1", public_metrics: { followers_count: 1234 } };
    await service.insertEvents([{
      userId: "u1", channelId: "chan1", eventType: "follow.follow", rawData, eventProps: resolvedEventProps,
    }]);

    const params = tenantDb.batch.mock.calls[0][0][0].params;
    expect(params).toContain(JSON.stringify(rawData));
  });
});
