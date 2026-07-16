import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0001-content-list-id",
  async apply(tdb) {
    try {
      await tdb.run("ALTER TABLE content ADD COLUMN list_id TEXT");
    } catch (e) {
      // Already applied by hand (dev's 7 tenant DBs, migrated before this runner
      // existed — see the X List Posts Trigger plan's Task 1). SQLite has no
      // "ADD COLUMN IF NOT EXISTS"; tolerate exactly this one error shape so this
      // migration converges those DBs into the tracked state on first run,
      // instead of requiring a separate one-time tracking-table backfill.
      if (!String(e).includes("duplicate column name")) throw e;
    }
    await tdb.run("DROP INDEX IF EXISTS idx_content_channel_source");
    await tdb.run(
      "CREATE UNIQUE INDEX idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL"
    );
    await tdb.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL"
    );
  },
};
