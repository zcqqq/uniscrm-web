import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "./types";
import { EntityStateStore } from "./services/entity-state";

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

  c.set("tenantId" as never, session.tenant_id);
  c.set("memberId" as never, session.member_id);
  c.set("email" as never, session.email);
  // entity_state lives in link's own LINK_DB (D1) — a small dedup-key/hot-follow-state index,
  // not a per-tenant data store — so unlike the old TenantDataDB it needs no lookup against
  // `tenants.d1_database_id` and is always available once tenant_id is known. Real entity rows
  // (user/content) now live in R2 Data Catalog, read via shared/r2-sql.ts at the route level.
  c.set("entityState" as never, new EntityStateStore(c.env.LINK_DB, session.tenant_id));

  await next();
}

export async function internalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
