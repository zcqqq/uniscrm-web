import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "../types";
import { TenantDataDB } from "../../../shared/tenant-data-db";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const data = await c.env.KV.get(`session:${sessionId}`);
  if (!data) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const session = JSON.parse(data) as Session;

  const row = await c.env.DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(session.tenant_id)
    .first<{ d1_database_id: string | null }>();

  if (!row?.d1_database_id) {
    return c.json({ error: "Tenant database not provisioned" }, 500);
  }

  const tenantDataDb = new TenantDataDB(
    c.env.CF_ACCOUNT_ID,
    c.env.CF_D1_API_TOKEN,
    row.d1_database_id
  );

  c.set("tenantId" as never, session.tenant_id);
  c.set("tenantDataDb" as never, tenantDataDb);
  c.set("memberId" as never, session.member_id);
  c.set("email" as never, session.email);
  await next();
}
