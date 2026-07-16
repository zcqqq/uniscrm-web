import { describe, it, expect, vi } from "vitest";
import { migration } from "./0001-content-list-id.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0001-content-list-id migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0001-content-list-id");
  });

  it("adds list_id, then drops and recreates the partial indexes in order", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE content ADD COLUMN list_id TEXT");
    expect(tdb.run).toHaveBeenNthCalledWith(2, "DROP INDEX IF EXISTS idx_content_channel_source");
    expect(tdb.run).toHaveBeenNthCalledWith(
      3,
      "CREATE UNIQUE INDEX idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL"
    );
    expect(tdb.run).toHaveBeenNthCalledWith(
      4,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL"
    );
  });

  it("tolerates a 'duplicate column name' error from the ALTER TABLE step and still runs the index steps", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: duplicate column name: list_id")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
    expect(tdb.run).toHaveBeenCalledTimes(4);
  });

  it("rethrows any other error from the ALTER TABLE step and stops", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: content")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: content");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });
});
