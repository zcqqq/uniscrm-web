import { describe, it, expect, vi } from "vitest";
import { migration } from "./0004-content-trigger-dedup.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0004-content-trigger-dedup migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0004-content-trigger-dedup");
  });

  it("creates content_trigger_dedup with an IF NOT EXISTS guard", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenCalledTimes(1);
    const [sql] = tdb.run.mock.calls[0];
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS content_trigger_dedup");
    expect(sql).toContain("PRIMARY KEY (channel_id, secondary_id, source_content_id)");
  });

  it("is safely re-runnable (idempotent CREATE, no error on a second apply against the same mock)", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);
    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });
});
