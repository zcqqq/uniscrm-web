import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { SessionService } from "./session";
import type { Env } from "../types";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    console.log("Auth: no session cookie. Cookie header:", c.req.header("Cookie") ?? "(none)");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sessions = new SessionService(c.env.KV);
  const session = await sessions.get(sessionId);
  if (!session) {
    console.log("Auth: session not found in KV for id:", sessionId);
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId" as never, session.user_id);
  c.set("email" as never, session.email);
  await next();
}
