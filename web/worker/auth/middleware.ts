import type { Context, Next } from "hono";
import { resolveSession } from "../../../shared/auth";
import { TenantDB } from "../../../shared/tenant-db";
import type { Env } from "../types";

// Session resolution lives in shared/auth.ts (one implementation for every worker);
// this middleware is web's adapter: 401 JSON on failure, context vars + tenant-scoped
// db on success.
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const session = await resolveSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("memberId" as never, session.memberId);
  c.set("tenantId" as never, session.tenantId);
  c.set("email" as never, session.email);
  c.set("db" as never, new TenantDB(c.env.WEB_DB, session.tenantId));
  await next();
}
