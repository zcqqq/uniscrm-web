# Tenant DB Migration Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable runner that applies versioned schema migrations to every already-provisioned tenant D1 database, wire it into both deploy workflows, and land the `content.list_id` change (from the X List Posts Trigger feature) as its first migration.

**Architecture:** A new `operation/` module (plain Node/TypeScript, no Cloudflare Worker runtime) with a `migrations/` directory of small `{ name, apply(tdb) }` modules and a runner script that lists all tenants (one `wrangler d1 execute` call against the fixed, named `WEB_DB`), then for each tenant's D1 database (addressed by id via the existing `shared/tenant-data-db.ts` REST client — no per-tenant `wrangler` CLI calls) applies any migration not yet recorded in a per-tenant `_tenant_migrations` tracking table.

**Tech Stack:** Node 22+ with `--experimental-strip-types` (no build step, no `tsx`/`ts-node`), Vitest (plain, no `@cloudflare/vitest-pool-workers` — this module has no Worker runtime), GitHub Actions.

## Global Constraints

- No rollback/`down` mechanism — matches every other migration system already in this repo (`wrangler d1 migrations`, `link/migrations/`, `flow/migrations/`).
- Does not touch `wrangler d1 migrations`' handling of the four standard shared DBs (`uniscrm-web`, `uniscrm-link`, `uniscrm-flow`, `uniscrm-admin`) — entirely separate mechanism, for per-tenant sharded DBs only.
- A failure migrating one tenant DB must not abort the run for other tenants — collect failures, exit non-zero at the end.
- The `0001-content-list-id` migration must tolerate re-running against dev's 7 tenant DBs that were already hand-migrated (Task 1 of the X List Posts Trigger plan, before this mechanism existed) — specifically, a "duplicate column name" error from its `ALTER TABLE ADD COLUMN` step must be swallowed, not fail the migration.
- `deploy-prod.yml` stays `workflow_dispatch`-only — this adds a job inside that existing manual trigger, not a new automatic one.

---

## Task 1: `operation/` module scaffolding

**Files:**
- Create: `operation/package.json`
- Create: `operation/tsconfig.json`
- Create: `operation/vitest.config.ts`

**Interfaces:**
- Produces: a working `cd operation && npm ci && npx vitest run` command, consumed by every later task's test steps and by Task 4's CI wiring.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "uniscrm-operation",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^4.1.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["*.ts", "migrations/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Plain Vitest — this module has no Cloudflare Worker runtime, so it does not use `@cloudflare/vitest-pool-workers` (unlike every other module's `vitest.config.ts` in this repo):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/node_modules/**"],
  },
});
```

- [ ] **Step 4: Install dependencies**

```bash
cd operation && npm install
```

Expected: `operation/package-lock.json` is created, `operation/node_modules` populated, no errors.

- [ ] **Step 5: Commit**

```bash
git add operation/package.json operation/package-lock.json operation/tsconfig.json operation/vitest.config.ts
git commit -m "chore(operation): scaffold new operation module for tenant-DB migration tooling"
```

---

## Task 2: Migration interface + `0001-content-list-id` migration

**Files:**
- Create: `operation/migrations/types.ts`
- Create: `operation/migrations/0001-content-list-id.ts`
- Test: `operation/migrations/0001-content-list-id.test.ts`

**Interfaces:**
- Consumes: `shared/tenant-data-db.ts`'s `TenantDataDB` class (`query<T>(sql, params?)`, `run(sql, params?)`, `batch(...)`, `getDbId()`).
- Produces: `TenantMigration { name: string; apply(tdb: TenantDataDB): Promise<void> }` (in `types.ts`), and one concrete migration object `migration` (in `0001-content-list-id.ts`). Consumed by Task 3's runner, which discovers and applies every file in this directory.

- [ ] **Step 1: Create the shared interface**

`operation/migrations/types.ts`:

```ts
import type { TenantDataDB } from "../../shared/tenant-data-db.ts";

export interface TenantMigration {
  name: string;
  apply(tdb: TenantDataDB): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

`operation/migrations/0001-content-list-id.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { migration } from "./0001-content-list-id.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0001-content-list-id migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0001-content-list-id");
  });

  it("adds list_id, then drops and recreates the partial indexes in order", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(1, "ALTER TABLE content ADD COLUMN list_id TEXT");
    expect(tdb.run).toHaveBeenNthCalledWith(2, "DROP INDEX IF EXISTS idx_content_channel_source");
    expect(tdb.run).toHaveBeenNthCalledWith(
      3,
      "CREATE UNIQUE INDEX idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL"
    );
    expect(tdb.run).toHaveBeenNthCalledWith(
      4,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL"
    );
  });

  it("tolerates a 'duplicate column name' error from the ALTER TABLE step and still runs the index steps", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: duplicate column name: list_id")));

    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
    expect(tdb.run).toHaveBeenCalledTimes(4);
  });

  it("rethrows any other error from the ALTER TABLE step and stops", async () => {
    const tdb = createMockTdb();
    tdb.run.mockImplementationOnce(() => Promise.reject(new Error("D1 run failed: no such table: content")));

    await expect(migration.apply(tdb as any)).rejects.toThrow("no such table: content");
    expect(tdb.run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd operation && npx vitest run migrations/0001-content-list-id.test.ts`
Expected: FAIL — `0001-content-list-id.ts` doesn't exist yet.

- [ ] **Step 4: Implement**

`operation/migrations/0001-content-list-id.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd operation && npx vitest run migrations/0001-content-list-id.test.ts`
Expected: PASS — 4/4 tests.

- [ ] **Step 6: Commit**

```bash
git add operation/migrations/types.ts operation/migrations/0001-content-list-id.ts operation/migrations/0001-content-list-id.test.ts
git commit -m "feat(operation): 0001-content-list-id tenant migration"
```

---

## Task 3: The runner

**Files:**
- Create: `operation/migrate-tenant-dbs.ts`
- Test: `operation/migrate-tenant-dbs.test.ts`

**Interfaces:**
- Consumes: Task 2's `TenantMigration` interface and `operation/migrations/` directory contents; `shared/tenant-data-db.ts`'s `TenantDataDB`.
- Produces: `resolveWebDbName(env: string): string`, `migrateTenantDb(tdb: TenantDataDB, tenantId: number, migrations: TenantMigration[]): Promise<void>`, `listTenants(env: string): { tenant_id: number; d1_database_id: string }[]`, `run(env: string, migrations?: TenantMigration[]): Promise<void>` — all exported for testing. Consumed by Task 4's CI step, which invokes this file directly as `node --experimental-strip-types operation/migrate-tenant-dbs.ts <dev|production>`.

- [ ] **Step 1: Write the failing tests**

`operation/migrate-tenant-dbs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { resolveWebDbName, migrateTenantDb, listTenants, run } from "./migrate-tenant-dbs.ts";
import type { TenantMigration } from "./migrations/types.ts";

describe("resolveWebDbName", () => {
  it("resolves dev to uniscrm-web-dev", () => {
    expect(resolveWebDbName("dev")).toBe("uniscrm-web-dev");
  });

  it("resolves production to uniscrm-web", () => {
    expect(resolveWebDbName("production")).toBe("uniscrm-web");
  });

  it("throws on an unknown env", () => {
    expect(() => resolveWebDbName("staging")).toThrow("Unknown env");
  });
});

describe("listTenants", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes wrangler d1 execute with the resolved db name and env, and parses results", () => {
    (execFileSync as any).mockReturnValue(
      JSON.stringify([{ results: [{ tenant_id: 1, d1_database_id: "db-1" }, { tenant_id: 2, d1_database_id: "db-2" }] }])
    );

    const tenants = listTenants("dev");

    expect(tenants).toEqual([{ tenant_id: 1, d1_database_id: "db-1" }, { tenant_id: 2, d1_database_id: "db-2" }]);
    expect(execFileSync).toHaveBeenCalledWith(
      "wrangler",
      expect.arrayContaining(["d1", "execute", "uniscrm-web-dev", "--env", "dev", "--remote", "--json"]),
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("returns an empty array when there are no tenants with a d1_database_id", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify([{ results: [] }]));
    expect(listTenants("production")).toEqual([]);
  });
});

function createMockTdb(existingMigrationNames: string[] = []) {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("FROM _tenant_migrations")) {
        const name = params?.[0];
        return Promise.resolve(existingMigrationNames.includes(name as string) ? [{ name }] : []);
      }
      return Promise.resolve([]);
    }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("migrateTenantDb", () => {
  it("creates the tracking table before checking any migration", async () => {
    const tdb = createMockTdb();
    await migrateTenantDb(tdb as any, 1, []);
    expect(tdb.run).toHaveBeenCalledWith(
      "CREATE TABLE IF NOT EXISTS _tenant_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
  });

  it("applies and records a migration not yet in the tracking table", async () => {
    const tdb = createMockTdb();
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const migration: TenantMigration = { name: "test-migration", apply: applyFn };

    await migrateTenantDb(tdb as any, 1, [migration]);

    expect(applyFn).toHaveBeenCalledWith(tdb);
    expect(tdb.run).toHaveBeenCalledWith(
      "INSERT INTO _tenant_migrations (name, applied_at) VALUES (?, datetime('now'))",
      ["test-migration"]
    );
  });

  it("skips a migration already recorded in the tracking table", async () => {
    const tdb = createMockTdb(["already-applied"]);
    const applyFn = vi.fn().mockResolvedValue(undefined);
    const migration: TenantMigration = { name: "already-applied", apply: applyFn };

    await migrateTenantDb(tdb as any, 1, [migration]);

    expect(applyFn).not.toHaveBeenCalled();
  });

  it("processes multiple migrations in the given order", async () => {
    const tdb = createMockTdb();
    const order: string[] = [];
    const migrations: TenantMigration[] = [
      { name: "m1", apply: async () => { order.push("m1"); } },
      { name: "m2", apply: async () => { order.push("m2"); } },
    ];

    await migrateTenantDb(tdb as any, 1, migrations);

    expect(order).toEqual(["m1", "m2"]);
  });
});

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
    process.env.CLOUDFLARE_API_TOKEN = "tok-1";
  });

  it("throws when CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is missing", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    (execFileSync as any).mockReturnValue(JSON.stringify([{ results: [] }]));
    await expect(run("dev", [])).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
  });

  it("continues to the next tenant when one tenant's migration fails, and sets a non-zero exitCode", async () => {
    (execFileSync as any).mockReturnValue(
      JSON.stringify([{ results: [{ tenant_id: 1, d1_database_id: "db-1" }, { tenant_id: 2, d1_database_id: "db-2" }] }])
    );
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("db-1")) return Promise.resolve(new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ success: true, result: [{ results: [], success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const previousExitCode = process.exitCode;
    await run("dev", []);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("db-1"), expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("db-2"), expect.anything());
    expect(process.exitCode).toBe(1);

    process.exitCode = previousExitCode;
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd operation && npx vitest run migrate-tenant-dbs.test.ts`
Expected: FAIL — `migrate-tenant-dbs.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

`operation/migrate-tenant-dbs.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TenantDataDB } from "../shared/tenant-data-db.ts";
import type { TenantMigration } from "./migrations/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TenantRow {
  tenant_id: number;
  d1_database_id: string;
}

export function resolveWebDbName(env: string): string {
  if (env === "production") return "uniscrm-web";
  if (env === "dev") return "uniscrm-web-dev";
  throw new Error(`Unknown env: ${env} (expected "dev" or "production")`);
}

export function listTenants(env: string): TenantRow[] {
  const dbName = resolveWebDbName(env);
  const output = execFileSync(
    "wrangler",
    [
      "d1", "execute", dbName,
      "--config", "web/wrangler.toml",
      "--env", env,
      "--remote",
      "--json",
      "--command", "SELECT tenant_id, d1_database_id FROM tenants WHERE d1_database_id IS NOT NULL",
    ],
    { encoding: "utf-8" }
  );
  const parsed = JSON.parse(output) as { results: TenantRow[] }[];
  return parsed[0]?.results || [];
}

async function loadMigrations(): Promise<TenantMigration[]> {
  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "types.ts")
    .sort();
  const migrations: TenantMigration[] = [];
  for (const file of files) {
    const mod = await import(`./migrations/${file}`);
    migrations.push(mod.migration as TenantMigration);
  }
  return migrations;
}

export async function migrateTenantDb(
  tdb: TenantDataDB,
  tenantId: number,
  migrations: TenantMigration[]
): Promise<void> {
  await tdb.run(
    "CREATE TABLE IF NOT EXISTS _tenant_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );

  for (const migration of migrations) {
    const existing = await tdb.query<{ name: string }>(
      "SELECT name FROM _tenant_migrations WHERE name = ?",
      [migration.name]
    );
    if (existing.length > 0) {
      console.log(JSON.stringify({ event: "tenant_migration_skipped", tenantId, migration: migration.name }));
      continue;
    }
    await migration.apply(tdb);
    await tdb.run(
      "INSERT INTO _tenant_migrations (name, applied_at) VALUES (?, datetime('now'))",
      [migration.name]
    );
    console.log(JSON.stringify({ event: "tenant_migration_applied", tenantId, migration: migration.name }));
  }
}

export async function run(env: string, migrations?: TenantMigration[]): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }

  const tenants = listTenants(env);
  const migs = migrations ?? (await loadMigrations());
  console.log(JSON.stringify({ event: "tenant_migration_run_started", env, tenantCount: tenants.length, migrationCount: migs.length }));

  const failures: { tenantId: number; error: string }[] = [];
  for (const tenant of tenants) {
    const tdb = new TenantDataDB(accountId, apiToken, tenant.d1_database_id);
    try {
      await migrateTenantDb(tdb, tenant.tenant_id, migs);
    } catch (e) {
      failures.push({ tenantId: tenant.tenant_id, error: String(e) });
      console.error(JSON.stringify({ event: "tenant_migration_failed", tenantId: tenant.tenant_id, error: String(e) }));
    }
  }

  console.log(JSON.stringify({ event: "tenant_migration_run_complete", env, total: tenants.length, failed: failures.length }));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.argv[2];
  if (!env) {
    console.error("Usage: node --experimental-strip-types migrate-tenant-dbs.ts <dev|production>");
    process.exit(2);
  }
  run(env).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd operation && npx vitest run migrate-tenant-dbs.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Run the full `operation` test suite**

Run: `cd operation && npx vitest run`
Expected: PASS — both test files (Task 2's and this task's), no regressions.

- [ ] **Step 6: Sanity-check the entry point runs under Node's type-stripping**

Run: `cd operation && node --experimental-strip-types migrate-tenant-dbs.ts` (no env arg)
Expected: prints `Usage: node --experimental-strip-types migrate-tenant-dbs.ts <dev|production>` to stderr and exits with code 2 — confirms the file parses and runs under `--experimental-strip-types` without needing a build step, and that the argv-guard branch works.

- [ ] **Step 7: Commit**

```bash
git add operation/migrate-tenant-dbs.ts operation/migrate-tenant-dbs.test.ts
git commit -m "feat(operation): tenant-DB migration runner (list tenants, apply pending migrations, per-tenant failure isolation)"
```

---

## Task 4: CI wiring

**Files:**
- Modify: `.github/workflows/deploy-dev.yml`
- Modify: `.github/workflows/deploy-prod.yml`

**Interfaces:**
- Consumes: Task 3's `operation/migrate-tenant-dbs.ts` entry point.

- [ ] **Step 1: Add the job to `deploy-dev.yml`**

In `.github/workflows/deploy-dev.yml`, add a new `migrate-tenant-dbs` job after the existing `migrate` job (same indentation level, as a sibling job):

```yaml
  migrate-tenant-dbs:
    needs: [sync-secrets]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install wrangler
        run: npm ci

      - name: Install operation dependencies
        run: cd operation && npm ci

      - name: Migrate tenant DBs
        run: node --experimental-strip-types operation/migrate-tenant-dbs.ts dev
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

(No `environment: dev` key — matching this file's existing `migrate` job, which also omits it; only jobs that need environment-scoped secrets like `STRIPE_SECRET_KEY` set that key in this file.)

Then update the `deploy` job's `needs:` line from:

```yaml
  deploy:
    needs: [migrate, changes]
```

to:

```yaml
  deploy:
    needs: [migrate, migrate-tenant-dbs, changes]
```

- [ ] **Step 2: Add the job to `deploy-prod.yml`**

In `.github/workflows/deploy-prod.yml`, add the same job after the existing `migrate` job, this time WITH `environment: production` (matching every other job in this file):

```yaml
  migrate-tenant-dbs:
    needs: [sync-secrets]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install wrangler
        run: npm ci

      - name: Install operation dependencies
        run: cd operation && npm ci

      - name: Migrate tenant DBs
        run: node --experimental-strip-types operation/migrate-tenant-dbs.ts production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

Then update the `deploy` job's `needs:` line from:

```yaml
  deploy:
    needs: [migrate]
```

to:

```yaml
  deploy:
    needs: [migrate, migrate-tenant-dbs]
```

- [ ] **Step 3: Validate YAML syntax**

Run: `cd /Users/zc/Documents/UniSCRM/uniscrm-web && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-dev.yml')); yaml.safe_load(open('.github/workflows/deploy-prod.yml')); print('OK')"`
Expected: `OK` (if `python3`/`pyyaml` isn't available in this environment, use `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/deploy-dev.yml','utf8'))"` or any locally available YAML parser — the goal is just confirming both files still parse as valid YAML after the edit, since there is no way to dry-run a GitHub Actions workflow locally).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-dev.yml .github/workflows/deploy-prod.yml
git commit -m "ci: run the tenant-DB migration runner before deploy, on both dev and production"
```

---

## Manual verification (after all tasks land and dev auto-deploys)

Once this merges to `main` and dev's `Deploy Dev` workflow runs: check the `migrate-tenant-dbs` job's logs for `tenant_migration_run_complete` with `failed: 0`, and spot-check one of the 7 previously hand-migrated dev tenant DBs via `wrangler d1 execute <tenant-db-name> --remote --command "SELECT name FROM _tenant_migrations"` — expect exactly one row, `0001-content-list-id`.
