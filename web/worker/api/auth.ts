import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/login", async (c) => {
    const body = await c.req.json<{ email?: string }>();
    if (!body.email) {
      return c.json({ error: "Email is required" }, 400);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await c.env.DB.prepare("INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)")
      .bind(token, body.email, expiresAt)
      .run();

    const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.APP_URL);
    await emailService.sendMagicLink(body.email, token);

    return c.json({ ok: true });
  });

  router.get("/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Token is required" }, 400);
    }

    const link = await c.env.DB.prepare("SELECT * FROM magic_links WHERE token = ?")
      .bind(token)
      .first<{ token: string; email: string; expires_at: string; used: number }>();

    if (!link || link.used || new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await c.env.DB.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
      .bind(token)
      .run();

    let user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
      .bind(link.email)
      .first<{ id: string; email: string }>();

    if (!user) {
      const userId = crypto.randomUUID();
      await c.env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
        .bind(userId, link.email, new Date().toISOString())
        .run();
      user = { id: userId, email: link.email };
    }

    const sessions = new SessionService(c.env.KV);
    const sessionId = await sessions.create(user.id, user.email);

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return c.json({ ok: true, user: { id: user.id, email: user.email } });
  });

  router.post("/logout", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (sessionId) {
      const sessions = new SessionService(c.env.KV);
      await sessions.destroy(sessionId);
    }
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

    const sessions = new SessionService(c.env.KV);
    const session = await sessions.get(sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    return c.json({ user: { id: session.user_id, email: session.email } });
  });

  return router;
}
