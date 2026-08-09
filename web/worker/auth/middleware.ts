import type { Context, Next } from "hono";
import { resolveSession } from "../../../shared/auth";
import type { Env } from "../types";

// Session resolution lives in shared/auth.ts (one implementation for every worker);
// this middleware is web's adapter: 401 JSON on failure, context vars on success.
// Routes query WEB_DB directly with an explicit tenant_id bind — gated by
// scripts/tenant-scope-audit.mjs, not by SQL rewriting.
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const session = await resolveSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("memberId" as never, session.memberId);
  c.set("tenantId" as never, session.tenantId);
  c.set("email" as never, session.email);
  await next();
}
