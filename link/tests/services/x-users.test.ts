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
      expect.stringContaining("UPDATE user"),
      expect.arrayContaining(["existing-uuid"])
    );
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
