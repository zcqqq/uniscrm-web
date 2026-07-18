import { describe, it, expect, vi } from "vitest";
import { migration } from "./0003-content-has-face.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0003-content-has-face migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0003-content-has-face");
  });

  it("adds the has_face column", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE content ADD COLUMN has_face INTEGER");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });

  it("tolerates a 'duplicate column name' error from the ALTER TABLE step", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: duplicate column name: has_face")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other error from the ALTER TABLE step", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: content")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: content");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });
});
