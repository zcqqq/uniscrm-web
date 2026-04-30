import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "../types";

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
  c.set("userId" as never, session.user_id);
  c.set("email" as never, session.email);
  await next();
}
