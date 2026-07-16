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
    "npx",
    [
      "wrangler",
      "d1", "execute", dbName,
      "--config", "web/wrangler.toml",
      "--env", env,
      "--remote",
      "--json",
      "--command", "SELECT tenant_id, d1_database_id FROM tenants WHERE d1_database_id IS NOT NULL",
    ],
    { encoding: "utf-8" }
  );
  let parsed: { results: TenantRow[] }[];
  try {
    parsed = JSON.parse(output);
  } catch (e) {
    throw new Error(
      `Failed to parse wrangler d1 execute output as JSON: ${String(e)}. Raw output (first 500 chars): ${output.slice(0, 500)}`
    );
  }
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
