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
      "npx",
      expect.arrayContaining(["wrangler", "d1", "execute", "uniscrm-web-dev", "--env", "dev", "--remote", "--json"]),
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("returns an empty array when there are no tenants with a d1_database_id", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify([{ results: [] }]));
    expect(listTenants("production")).toEqual([]);
  });

  it("throws a diagnosable error including the raw output when wrangler output is not valid JSON", () => {
    (execFileSync as any).mockReturnValue("not json at all");
    expect(() => listTenants("dev")).toThrow("not json at all");
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
