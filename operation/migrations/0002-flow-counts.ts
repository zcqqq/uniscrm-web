import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0002-flow-counts",
  async apply(tdb) {
    await tdb.run(`CREATE TABLE IF NOT EXISTS flow_counts (
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, node_id, direction)
    )`);
    await tdb.run(`CREATE TABLE IF NOT EXISTS content_flow_counts (
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, node_id, direction)
    )`);
    // Old D1 flow_log is retired outright (not migrated) — its detail data moves to
    // R2 (flow_log/content_flow_log Iceberg tables, Task 1), and nothing reads this
    // D1 table going forward once Tasks 6-7 land. Dropped here rather than left as
    // unread dead weight, per an explicit decision (not a backfill oversight).
    await tdb.run("DROP TABLE IF EXISTS flow_log");
  },
};
