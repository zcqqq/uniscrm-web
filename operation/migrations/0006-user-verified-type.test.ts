import { describe, it, expect, vi } from "vitest";
import { migration } from "./0006-user-verified-type.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0006-user-verified-type migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0006-user-verified-type");
  });

  it("adds the verified_type column to user", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE user ADD COLUMN verified_type TEXT");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });

  it("tolerates a DB already provisioned with verified_type ('duplicate column name')", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: duplicate column name: verified_type")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });

  it("rethrows any other error", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: user")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: user");
  });
});
