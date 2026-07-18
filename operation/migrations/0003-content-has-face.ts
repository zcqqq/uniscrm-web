import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0003-content-has-face",
  async apply(tdb) {
    try {
      await tdb.run("ALTER TABLE content ADD COLUMN has_face INTEGER");
    } catch (e) {
      // Task 1 added has_face to the new-tenant provisioning SQL
      // (admin/src/services/tenant-init-sql.ts), which is a separate path from
      // this migration (existing tenant DBs). In case the column was also added
      // by hand on some existing tenant DB during YouTube content trigger dev
      // work before this migration existed, tolerate that one error shape —
      // same pattern as 0001-content-list-id.ts — since SQLite has no "ADD
      // COLUMN IF NOT EXISTS", so this migration still converges that DB into
      // the tracked state on first run instead of failing.
      if (!String(e).includes("duplicate column name")) throw e;
    }
  },
};
