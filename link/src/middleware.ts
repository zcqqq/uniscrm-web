import type { Context, Next } from "hono";
import type { Env } from "./types";
import { EntityStateStore } from "./services/entity-state";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { createInternalAuthMiddleware, resolveSession } from "../../shared/auth";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  // Session resolution is shared/auth.ts's single D1 implementation. (This middleware
  // used to try KV first — that writer was long gone, so the KV branch was dead code
  // that also stubbed email to ""; sessions live in the D1 `sessions` table only.)
  const session = await resolveSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("tenantId" as never, session.tenantId);
  c.set("memberId" as never, session.memberId);
  c.set("email" as never, session.email);
  // entity_state lives in link's own LINK_DB (D1) — a small shared index, not a per-tenant data
  // store — so unlike TenantDataDB below it needs no lookup against `tenants.d1_database_id`
  // and is always available once tenant_id is known. Its job has shrunk to two things: trigger
  // content's seen-dedup ledger (recordTriggerContentSeen — trigger content is never persisted
  // as a row at all) and a follow-state mirror (mirrorFollowState in x-users.ts) kept for fast
  // reads that don't need a per-tenant D1 round trip. The user/content rows themselves are NOT
  // read from here or from R2 at route level — D1 is the truth (2026-07-26 plan: user/content
  // back to per-tenant D1), read via `tenantDataDb` below; R2 is an analytics-only copy.
  c.set("entityState" as never, new EntityStateStore(c.env.LINK_DB, session.tenantId));

  // Per-tenant D1 (task 4 of user/content-back-to-tenant-d1): only injected when the tenant
  // has been provisioned with its own D1 database. Consumers that need it must treat absence
  // as "not provisioned" and respond 503 rather than assuming it is always set.
  const row = await c.env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(session.tenantId)
    .first<{ d1_database_id: string | null }>();
  if (row?.d1_database_id) {
    c.set("tenantDataDb" as never, new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  }

  await next();
}

// Shared fail-closed implementation; link's historical 403 {"error":"Forbidden"} shape
// is preserved via opts (flow/admin answer 401 — see shared/auth.ts).
export const internalAuthMiddleware = createInternalAuthMiddleware({ status: 403, error: "Forbidden" });
