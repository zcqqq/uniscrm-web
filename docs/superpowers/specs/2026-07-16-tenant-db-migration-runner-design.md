# Tenant DB Migration Runner Design

## Context

[X List Posts Trigger](2026-07-15-x-list-posts-trigger-design.md) added a `content.list_id` column and replaced `content`'s single unique index with two partial ones, in `admin/src/services/tenant-init-sql.ts` (`TENANT_DB_INIT_SQL`, run once per tenant at provisioning time). That array only affects *new* tenants — the change was applied to dev's 7 existing tenant DBs by hand (`wrangler d1 execute` per DB, resolving each UUID to a name first since `wrangler d1 execute` only accepts a DB name, not a raw id). Production has its own set of existing tenant DBs this code has never touched, and production deploys are already a separate, manually-triggered `workflow_dispatch` (`.github/workflows/deploy-prod.yml`) — so there is no automatic path today that would apply this (or any future) schema change to an already-provisioned tenant DB.

This is not a one-off gap: `TENANT_DB_INIT_SQL`'s own shape (grow-only, `CREATE ... IF NOT EXISTS`) already assumes new tables/columns will need to reach existing tenants eventually, and this project's `CLAUDE.md` earmarks an `operation/` module for exactly this kind of production-ops task ("生产环境运维相关，可以存储一些修复数据的临时脚本") — it just doesn't exist yet. This design builds that mechanism, generically, with the `list_id` change as its first entry.

## Scope

- A reusable runner that applies a set of versioned, per-tenant-DB migrations to every existing tenant database, tracked so each migration runs at most once per tenant DB.
- Wired into both `deploy-dev.yml` (auto-deploys on push to `main`) and `deploy-prod.yml` (manual `workflow_dispatch`) as a new CI job, gating the `deploy` job.
- The `list_id` + partial-index change (already applied by hand to dev) becomes migration `0001`, written so it converges dev's already-migrated tenant DBs into the same tracked state with no separate backfill step.

## Out of scope

- Retrofitting `TENANT_DB_INIT_SQL` itself or changing new-tenant provisioning — this only concerns *already-provisioned* tenant DBs.
- A rollback/`down` mechanism — matches `wrangler d1 migrations`' own one-directional model; none of this project's other migration systems (`link/migrations/`, `flow/migrations/`, etc.) support rollback either.
- Any change to how `wrangler d1 migrations` manages the four standard shared DBs (`uniscrm-web`, `uniscrm-link`, `uniscrm-flow`, `uniscrm-admin`) — that mechanism is untouched and unrelated; this only concerns per-tenant sharded DBs, which it doesn't cover.

## 1. Migration file format

New directory `operation/migrations/`. Each file exports one object:

```ts
// operation/migrations/0001-content-list-id.ts
import type { TenantDataDB } from "../../shared/tenant-data-db";

export interface TenantMigration {
  name: string;
  apply(tdb: TenantDataDB): Promise<void>;
}

export const migration: TenantMigration = {
  name: "0001-content-list-id",
  async apply(tdb) {
    try {
      await tdb.run("ALTER TABLE content ADD COLUMN list_id TEXT");
    } catch (e) {
      // Already applied by hand (dev's 7 tenant DBs, before this runner existed) —
      // SQLite has no "ADD COLUMN IF NOT EXISTS"; tolerate exactly this one error
      // shape and let the migration continue, rather than requiring a separate
      // one-time backfill of the tracking table for those DBs.
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
```

A plain `.sql` file can't express the duplicate-column tolerance a real incremental migration sometimes needs (this one does, on day one) — a small TS module can, and every future migration gets the same escape hatch for free without changing the runner.

## 2. Runner

`operation/migrate-tenant-dbs.ts`, invoked as `node --experimental-strip-types operation/migrate-tenant-dbs.ts <env>`. This repo has no prior standalone-TS-script convention (existing `scripts/` are all `.sh`), so this establishes one: CI's `actions/setup-node@v4` already pins Node 22 (`node-version: '22'`), and Node 22.6+ supports `--experimental-strip-types` for exactly this kind of basic-TypeScript (type annotations/interfaces, no decorators/enums) standalone execution — no build step, no `tsx`/`ts-node` dependency added. `CF_API_TOKEN`/`CF_ACCOUNT_ID` come from the environment (already available as GitHub secrets in both deploy workflows).

1. Resolves the `WEB_DB` name for the target env (`uniscrm-web` for production, `uniscrm-web-dev` for dev) and runs one `wrangler d1 execute <name> --config web/wrangler.toml --env <dev|production> --remote --json --command "SELECT tenant_id, d1_database_id FROM tenants WHERE d1_database_id IS NOT NULL"` to list every tenant's D1 database id — the exact flag set already proven to work in Task 1's manual dev migration. This is the only `wrangler` CLI call in the whole runner — a single fixed, named DB, not a per-tenant loop.
2. For each returned `d1_database_id`, constructs a `TenantDataDB(accountId, apiToken, dbId)` (the existing `shared/tenant-data-db.ts` REST client — it takes a database id directly, so no `wrangler d1 list` name-resolution step is needed here, unlike the CLI-based approach Task 1 used by hand).
3. Runs `CREATE TABLE IF NOT EXISTS _tenant_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` against that tenant DB.
4. Reads every file in `operation/migrations/`, sorted by filename (numeric prefix order). For each, `SELECT name FROM _tenant_migrations WHERE name = ?` — skip if found; otherwise call `migration.apply(tdb)`, then `INSERT INTO _tenant_migrations (name, applied_at) VALUES (?, datetime('now'))`.
5. Logs, per tenant DB, which migrations were applied/skipped, and continues to the next tenant DB on a per-tenant failure (collects failures, exits non-zero at the end if any tenant failed) rather than aborting the whole run on the first error — one broken tenant DB shouldn't block every other tenant's migration.

## 3. CI wiring

New job `migrate-tenant-dbs` added to both `.github/workflows/deploy-dev.yml` and `.github/workflows/deploy-prod.yml`:

```yaml
migrate-tenant-dbs:
  needs: [sync-secrets]
  runs-on: ubuntu-latest
  environment: production   # or no `environment:` line for deploy-dev.yml, matching that file's existing job style
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
    - name: Install wrangler
      run: npm ci
    - name: Migrate tenant DBs
      run: node --experimental-strip-types operation/migrate-tenant-dbs.ts <dev|production>
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

`deploy`'s `needs:` gains `migrate-tenant-dbs` alongside its existing `migrate` dependency (both must finish; no ordering between them, since they touch entirely different databases). `deploy-prod.yml` stays `workflow_dispatch`-only — this job just becomes one more step inside that existing manual trigger, not a new automatic trigger.

## Testing

- Unit tests for the runner's core logic (`operation/migrate-tenant-dbs.ts`) with a mocked `TenantDataDB`: skips an already-recorded migration; applies and records an unrecorded one; a per-tenant failure doesn't abort the rest of the run; the WEB_DB tenant-listing step's SQL/env-name selection is correct per `<dev|production>` argument.
- Unit test for migration `0001-content-list-id`: applying it twice against a mocked `TenantDataDB` behaves the same the second time as skip-via-tracking-table would (i.e., the migration itself is also safely re-runnable, defense in depth beyond the tracking table); the duplicate-column-name error is swallowed, any other error from the `ALTER TABLE` step is not.
- Manual dev verification: run the new CI job (or the script directly against dev) and confirm all 7 existing dev tenant DBs' `_tenant_migrations` tables end up with a `0001-content-list-id` row, with no errors, converging cleanly despite having been hand-migrated before this mechanism existed.

## Non-goals

- A `down`/rollback mechanism (see Out of scope).
- Retrying a failed tenant DB automatically within the same run — a failure is logged and the run exits non-zero; re-running the whole job (idempotent per-tenant via the tracking table) is the retry mechanism.
- Parallelizing the per-tenant-DB loop — sequential is simpler and safer for a first version; revisit only if the tenant count makes CI runtime a real problem.
