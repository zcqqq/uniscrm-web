import { describe, it, expect, vi } from "vitest";
import { migration } from "./0007-drop-user-profile-fk.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0007-drop-user-profile-fk migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0007-drop-user-profile-fk");
  });

  it("drops user.profile_id, which takes the dangling REFERENCES profile(id) with it", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE user DROP COLUMN profile_id");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });

  it("tolerates a DB that never had the column ('no such column')", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such column: profile_id")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });

  it("rethrows any other error", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: user")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: user");
  });
});
