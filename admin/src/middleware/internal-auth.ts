import type { Context, Next } from "hono";
import type { Env } from "../types";

export async function internalAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const secret = c.req.header("X-Internal-Secret");
  if (!secret || secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}
