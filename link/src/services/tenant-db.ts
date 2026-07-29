import type { Env } from "../types";
import { TenantDataDB } from "../../../shared/tenant-data-db";

// Per-tenant D1 — the source of truth (2026-07-26 plan: user/content back to per-tenant D1).
// Returns null when the tenant has no provisioned database yet (dev has several e2e test
// tenants in this state) — every caller below must skip BEFORE any external API call once it
// sees null, not just before the D1 write (last round's I1 lesson: burning an X/TikTok token
// refresh for a tenant that can't persist the result anyway).
export async function resolveTenantDb(env: Env, tenantId: number): Promise<TenantDataDB | null> {
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return null;
  return new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
}
