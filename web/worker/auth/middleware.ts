import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { SessionService } from "./session";
import { TenantDB } from "../../../shared/tenant-db";
import type { Env } from "../types";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sessions = new SessionService(c.env.KV);
  const session = await sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("memberId" as never, session.member_id);
  c.set("tenantId" as never, session.tenant_id);
  c.set("email" as never, session.email);
  c.set("db" as never, new TenantDB(c.env.DB, session.tenant_id));
  await next();
}
