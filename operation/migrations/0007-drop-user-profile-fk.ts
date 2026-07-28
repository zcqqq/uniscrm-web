import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0007-drop-user-profile-fk",
  async apply(tdb) {
    // Tenant DBs provisioned before the profile module was retired carry
    // `profile_id TEXT REFERENCES profile(id)` on `user`. Dropping the `profile` table
    // (2026-07-26 dev / 2026-07-27 prod cleanup) left that foreign key dangling: SELECTs
    // still work, but D1 enforces foreign keys, so EVERY insert into `user` dies with
    // "no such table: main.profile" — silently killing the followers poller and every
    // webhook user upsert. Observed live on uniscrm-t1-dev 2026-07-28.
    //
    // The column is dead either way (no code reads or writes it, and it is NULL in 100% of
    // rows across all four tenant DBs), and dropping it takes the REFERENCES clause with it,
    // so no table rebuild is needed. Newly provisioned DBs never had it — tenant-init-sql.ts
    // has no profile_id (admin/tests/unit/tenant-init-sql.test.ts asserts exactly that).
    try {
      await tdb.run("ALTER TABLE user DROP COLUMN profile_id");
    } catch (e) {
      // SQLite has no "DROP COLUMN IF EXISTS", and a DB provisioned from the current
      // tenant-init-sql.ts (or already hand-patched, as uniscrm-t1-dev was on 2026-07-28)
      // has nothing to drop. Converge quietly on that; anything else is a real failure.
      const msg = String(e);
      if (!msg.includes("no such column") && !msg.includes("cannot drop column")) throw e;
      console.log(JSON.stringify({
        event: "tenant_migration_column_already_absent",
        migration: "0007-drop-user-profile-fk",
        column: "user.profile_id",
      }));
    }
  },
};
