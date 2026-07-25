import { describe, it, expect, vi } from "vitest";
import { migration } from "./0005-user-post-count.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0005-user-post-count migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0005-user-post-count");
  });

  it("renames user.tweet_count to post_count", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE user RENAME COLUMN tweet_count TO post_count");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });

  it("tolerates a DB already provisioned with post_count ('no such column')", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such column: tweet_count")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });

  it("tolerates a DB that somehow has both columns ('duplicate column name')", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: duplicate column name: post_count")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });

  it("rethrows any other error", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: user")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: user");
  });
});
