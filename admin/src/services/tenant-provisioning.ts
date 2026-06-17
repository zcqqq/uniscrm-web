import { TenantDataDB } from "./tenant-data-db";
import { TENANT_DB_INIT_SQL } from "./tenant-init-sql";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export class TenantProvisioning {
  constructor(
    private accountId: string,
    private apiToken: string,
    private mainDb: D1Database
  ) {}

  async provisionDatabase(tenantId: number): Promise<string> {
    const dbName = `uniscrm-tenant-${tenantId}`;

    const res = await fetch(`${CF_API_BASE}/accounts/${this.accountId}/d1/database`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: dbName }),
    });
    const data = await res.json() as { result: { uuid: string }; success: boolean; errors: { message: string }[] };
    if (!data.success) {
      throw new Error(`Failed to create D1: ${data.errors?.[0]?.message || "unknown"}`);
    }

    const dbId = data.result.uuid;

    const tenantDb = new TenantDataDB(this.accountId, this.apiToken, dbId);
    for (const sql of TENANT_DB_INIT_SQL) {
      await tenantDb.run(sql);
    }

    await this.mainDb.prepare("UPDATE tenants SET d1_database_id = ? WHERE tenant_id = ?")
      .bind(dbId, tenantId)
      .run();

    return dbId;
  }

  async getTenantDbId(tenantId: number): Promise<string | null> {
    const row = await this.mainDb.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ d1_database_id: string | null }>();
    return row?.d1_database_id || null;
  }
}
