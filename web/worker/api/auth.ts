import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";
import { PendingTaskService } from "../services/pending-tasks";
import { executePendingTask } from "../services/task-executor";

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/login", async (c) => {
    const body = await c.req.json<{ email?: string; trial?: string; timezone?: string }>();
    if (!body.email) {
      return c.json({ error: "Email is required" }, 400);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await c.env.WEB_DB.prepare("INSERT INTO magic_links (token, email, expires_at, trial, timezone) VALUES (?, ?, ?, ?, ?)")
      .bind(token, body.email, expiresAt, body.trial ?? null, body.timezone ?? null)
      .run();

    const emailService = new EmailService(c.env.EMAIL_WEB, c.env.WEB_URL);
    try {
      await emailService.sendMagicLink(body.email, token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Email send failed:", msg);
      return c.json({ error: "Failed to send email", detail: msg }, 500);
    }

    return c.json({ ok: true });
  });

  router.get("/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Token is required" }, 400);
    }

    const link = await c.env.WEB_DB.prepare("SELECT * FROM magic_links WHERE token = ?")
      .bind(token)
      .first<{ token: string; email: string; expires_at: string; used: number; trial: string | null; timezone: string | null }>();

    if (!link || link.used || new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await c.env.WEB_DB.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
      .bind(token)
      .run();

    let member = await c.env.WEB_DB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language, timezone FROM members WHERE email = ?"
    )
      .bind(link.email)
      .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string; timezone: string }>();

    if (!member) {
      const memberId = crypto.randomUUID();
      const now = new Date().toISOString();

      await c.env.WEB_DB.prepare("INSERT INTO tenants (email, created_at) VALUES (?, ?)")
        .bind(link.email, now)
        .run();
      const tenant = await c.env.WEB_DB.prepare("SELECT tenant_id FROM tenants WHERE email = ?")
        .bind(link.email)
        .first<{ tenant_id: number }>();
      const tenantId = tenant!.tenant_id;

      const tz = link.timezone || "UTC";
      await c.env.WEB_DB.prepare(
        "INSERT INTO members (id, tenant_id, email, preferred_location, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(memberId, tenantId, link.email, "global", tz, now)
        .run();

      const tasks = new PendingTaskService(c.env.WEB_DB);
      const t1 = await tasks.create("provision-db", { tenant_id: tenantId });
      const t2 = await tasks.create("activate-trial", { tenant_id: tenantId, tier: "basic", days: 30 });
      c.executionCtx.waitUntil(executePendingTask(c.env, tasks, t1));
      c.executionCtx.waitUntil(executePendingTask(c.env, tasks, t2));

      member = { id: memberId, tenant_id: tenantId, email: link.email, preferred_location: "global", language: "en", timezone: tz };
    }

    const sessions = new SessionService(c.env.WEB_DB);
    const sessionId = await sessions.create(member.id, member.tenant_id, member.email, member.language || "en");

    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });
    setCookie(c, "tier", "basic", {
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });

    return c.json({
      ok: true,
      member: { id: member.id, email: member.email, preferred_location: member.preferred_location, language: member.language || "en", timezone: member.timezone || "UTC" },
      tenant: { id: member.tenant_id, email: member.email },
    });
  });

  router.post("/logout", async (c) => {
    const sessionId = getCookie(c, "session");
    if (sessionId) {
      const sessions = new SessionService(c.env.WEB_DB);
      await sessions.destroy(sessionId);
    }
    deleteCookie(c, "session", { path: "/", domain: "uni-scrm.com" });
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const sessionId = getCookie(c, "session");
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

    const sessions = new SessionService(c.env.WEB_DB);
    const session = await sessions.get(sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const member = await c.env.WEB_DB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language, timezone FROM members WHERE id = ?"
    )
      .bind(session.member_id)
      .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string; timezone: string }>();
    if (!member) return c.json({ error: "Unauthorized" }, 401);

    return c.json({
      member: { id: member.id, email: member.email, preferred_location: member.preferred_location, language: member.language || "en", timezone: member.timezone || "UTC" },
      tenant: { id: member.tenant_id, email: member.email },
    });
  });

  return router;
}
