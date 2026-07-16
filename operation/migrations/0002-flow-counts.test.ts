import { describe, it, expect, vi } from "vitest";
import { migration } from "./0002-flow-counts.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0002-flow-counts migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0002-flow-counts");
  });

  it("creates flow_counts, content_flow_counts, and drops the old flow_log table, in order", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("CREATE TABLE IF NOT EXISTS flow_counts")
    );
    expect(tdb.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("CREATE TABLE IF NOT EXISTS content_flow_counts")
    );
    expect(tdb.run).toHaveBeenNthCalledWith(3, "DROP TABLE IF EXISTS flow_log");
    expect(tdb.run).toHaveBeenCalledTimes(3);
  });
});
