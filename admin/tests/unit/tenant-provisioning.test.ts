import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TenantProvisioning } from "../../src/services/tenant-provisioning";
import { TENANT_DB_INIT_SQL } from "../../src/services/tenant-init-sql";

// Fake main-D1 (WEB_DB) backing TenantProvisioning's d1_database_id read/write,
// following the repo's fake-D1 test convention (admin/tests/unit/webhook.test.ts).
class FakeMainDb {
  rows: Record<number, { d1_database_id: string | null }> = {};

  prepare(sql: string) {
    const db = this;
    return {
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT d1_database_id FROM tenants")) {
          const [tenantId] = this._params as [number];
          return (db.rows[tenantId] as T) ?? null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("UPDATE tenants SET d1_database_id")) {
          const [dbId, tenantId] = this._params as [string, number];
          db.rows[tenantId] = { d1_database_id: dbId };
        }
        return { meta: { changes: 1 } };
      },
    };
  }
}

describe("TenantProvisioning", () => {
  let mainDb: FakeMainDb;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mainDb = new FakeMainDb();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("provisionDatabase", () => {
    it("creates a dev-suffixed D1 database, runs every init statement, and writes d1_database_id back", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/d1/database")) {
          return new Response(JSON.stringify({ success: true, result: { uuid: "new-db-id" } }));
        }
        // TenantDataDB.run() posts to /d1/database/<id>/query
        return new Response(JSON.stringify({ success: true, result: [{ results: [], success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }));
      });

      const provisioning = new TenantProvisioning("acct-1", "token-1", mainDb as unknown as D1Database, "dev");
      const dbId = await provisioning.provisionDatabase(42);

      expect(dbId).toBe("new-db-id");
      expect(mainDb.rows[42]).toEqual({ d1_database_id: "new-db-id" });

      const createCall = fetchMock.mock.calls.find(([url]) => (url as string).endsWith("/d1/database"));
      expect(createCall).toBeTruthy();
      const [createUrl, createInit] = createCall!;
      expect(createUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database");
      expect(JSON.parse((createInit as RequestInit).body as string)).toEqual({ name: "uniscrm-t42-dev" });

      // One init-SQL statement per TENANT_DB_INIT_SQL entry, plus the create call itself.
      const queryCalls = fetchMock.mock.calls.filter(([url]) => (url as string).endsWith("/query"));
      expect(queryCalls).toHaveLength(TENANT_DB_INIT_SQL.length);
    });

    it("names the database without a -dev suffix in production", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/d1/database")) {
          return new Response(JSON.stringify({ success: true, result: { uuid: "prod-db-id" } }));
        }
        return new Response(JSON.stringify({ success: true, result: [{ results: [], success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }));
      });

      const provisioning = new TenantProvisioning("acct-1", "token-1", mainDb as unknown as D1Database, "production");
      await provisioning.provisionDatabase(7);

      const [, createInit] = fetchMock.mock.calls.find(([url]) => (url as string).endsWith("/d1/database"))!;
      expect(JSON.parse((createInit as RequestInit).body as string)).toEqual({ name: "uniscrm-t7" });
    });

    it("throws when the Cloudflare API reports failure", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, errors: [{ message: "quota exceeded" }] })));

      const provisioning = new TenantProvisioning("acct-1", "token-1", mainDb as unknown as D1Database, "dev");
      await expect(provisioning.provisionDatabase(1)).rejects.toThrow("quota exceeded");
    });
  });

  describe("getTenantDbId", () => {
    it("returns null when the tenant has not been provisioned yet", async () => {
      const provisioning = new TenantProvisioning("acct-1", "token-1", mainDb as unknown as D1Database, "dev");
      await expect(provisioning.getTenantDbId(99)).resolves.toBeNull();
    });

    it("returns the stored d1_database_id once provisioning has run", async () => {
      mainDb.rows[5] = { d1_database_id: "existing-db-id" };
      const provisioning = new TenantProvisioning("acct-1", "token-1", mainDb as unknown as D1Database, "dev");
      await expect(provisioning.getTenantDbId(5)).resolves.toBe("existing-db-id");
    });
  });
});
