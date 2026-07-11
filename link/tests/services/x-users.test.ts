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
      followers_count: 42, // isInsight: true in PROPS_X
      is_followed: 1, // isInsight: true in PROPS_X
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
