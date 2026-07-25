import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0005-user-post-count",
  async apply(tdb) {
    // PROPS renamed this prop tweet_count -> post_count (platform-neutral), but storage
    // kept X's name, so every writer silently dropped it: the poller path resolves
    // `post_count` and found no such column, and analytics offers `post_count` as a
    // dimension against an R2 table that had `tweet_count`. Renaming the column — rather
    // than reverting the propId — makes storage match the metadata vocabulary that the
    // other modules already speak.
    try {
      await tdb.run("ALTER TABLE user RENAME COLUMN tweet_count TO post_count");
    } catch (e) {
      // Same tolerance pattern as 0003: SQLite has no "RENAME COLUMN IF EXISTS", and a
      // tenant DB may already be in the target state (hand-fixed, or provisioned from
      // admin/src/services/tenant-init-sql.ts after it was updated). Converge quietly
      // in that case; anything else is a real failure.
      const msg = String(e);
      const alreadyRenamed = msg.includes("no such column") || msg.includes("duplicate column name");
      if (!alreadyRenamed) throw e;
    }
  },
};
