import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Try KV first, fall back to D1 sessions table
  let session: Session | null = null;
  const kvData = await c.env.KV.get(`session:${sessionId}`);
  if (kvData) {
    session = JSON.parse(kvData) as Session;
  } else {
    const dbRow = await c.env.WEB_DB
      .prepare("SELECT tenant_id, member_id FROM sessions WHERE id = ? AND expires_at > datetime('now')")
      .bind(sessionId)
      .first<{ tenant_id: number; member_id: string }>();
    if (dbRow) {
      session = { tenant_id: dbRow.tenant_id, member_id: dbRow.member_id, email: "" };
    }
  }

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const row = await c.env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(session.tenant_id)
    .first<{ d1_database_id: string | null }>();

  c.set("tenantId" as never, session.tenant_id);
  c.set("memberId" as never, session.member_id);
  c.set("email" as never, session.email);

  if (row?.d1_database_id) {
    const tenantDataDb = new TenantDataDB(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_D1_API_TOKEN,
      row.d1_database_id
    );
    c.set("tenantDataDb" as never, tenantDataDb);
  }

  await next();
}

export async function internalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
