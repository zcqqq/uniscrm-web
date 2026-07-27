import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "./types";
import { EntityStateStore } from "./services/entity-state";
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

  c.set("tenantId" as never, session.tenant_id);
  c.set("memberId" as never, session.member_id);
  c.set("email" as never, session.email);
  // entity_state lives in link's own LINK_DB (D1) — a small shared index, not a per-tenant data
  // store — so unlike TenantDataDB below it needs no lookup against `tenants.d1_database_id`
  // and is always available once tenant_id is known. Its job has shrunk to two things: trigger
  // content's seen-dedup ledger (recordTriggerContentSeen — trigger content is never persisted
  // as a row at all) and a follow-state mirror (mirrorFollowState in x-users.ts) kept for fast
  // reads that don't need a per-tenant D1 round trip. The user/content rows themselves are NOT
  // read from here or from R2 at route level — D1 is the truth (2026-07-26 plan: user/content
  // back to per-tenant D1), read via `tenantDataDb` below; R2 is an analytics-only copy.
  c.set("entityState" as never, new EntityStateStore(c.env.LINK_DB, session.tenant_id));

  // Per-tenant D1 (task 4 of user/content-back-to-tenant-d1): only injected when the tenant
  // has been provisioned with its own D1 database. Consumers that need it must treat absence
  // as "not provisioned" and respond 503 rather than assuming it is always set.
  const row = await c.env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(session.tenant_id)
    .first<{ d1_database_id: string | null }>();
  if (row?.d1_database_id) {
    c.set("tenantDataDb" as never, new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  }

  await next();
}

export async function internalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const secret = c.req.header("X-Internal-Secret");
  // Fail closed: with INTERNAL_SECRET unset, `undefined !== undefined` would let
  // header-less requests through.
  if (!c.env.INTERNAL_SECRET || secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
