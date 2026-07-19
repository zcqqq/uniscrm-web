import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0004-content-trigger-dedup",
  async apply(tdb) {
    await tdb.run(`CREATE TABLE IF NOT EXISTS content_trigger_dedup (
      channel_id TEXT NOT NULL,
      secondary_id TEXT NOT NULL DEFAULT '',
      source_content_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, secondary_id, source_content_id)
    )`);
  },
};
