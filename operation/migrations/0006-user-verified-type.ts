import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0006-user-verified-type",
  async apply(tdb) {
    // `verified_type` is one of UserMetadata_X's mapped userProps and a real column in both
    // the R2 `user` schema and TENANT_DB_INIT_SQL, but TENANT_DB_INIT_SQL only ever runs
    // CREATE TABLE IF NOT EXISTS — it does nothing for a tenant DB that predates the column.
    // uniscrm-t1-dev is exactly that DB, so the first D1 user write from x-users.ts would die
    // with "no such column: verified_type" (found by task 5's reviewer).
    try {
      await tdb.run("ALTER TABLE user ADD COLUMN verified_type TEXT");
    } catch (e) {
      // Same tolerance pattern as 0005: SQLite has no "ADD COLUMN IF NOT EXISTS", and a tenant
      // DB may already be in the target state — every DB provisioned from the current
      // admin/src/services/tenant-init-sql.ts already has the column, and dev was hand-patched
      // with this exact ALTER before the migration ledger existed. Converge quietly in that
      // case; anything else is a real failure.
      const msg = String(e);
      if (!msg.includes("duplicate column name")) throw e;
      console.log(JSON.stringify({
        event: "tenant_migration_column_already_present",
        migration: "0006-user-verified-type",
        column: "user.verified_type",
      }));
    }
  },
};
