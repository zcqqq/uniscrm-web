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

    const link = await c.env.DB.prepare("SELECT * FROM magic_links WHERE token = ?")
      .bind(token)
      .first<{ token: string; email: string; expires_at: string; used: number }>();

    if (!link || link.used || new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await c.env.DB.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
      .bind(token)
      .run();

    let member = await c.env.DB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language FROM members WHERE email = ?"
    )
      .bind(link.email)
      .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string }>();

    if (!member) {
      const memberId = crypto.randomUUID();
      const now = new Date().toISOString();

      await c.env.DB.prepare("INSERT INTO tenants (email, created_at) VALUES (?, ?)")
        .bind(link.email, now)
        .run();
      const tenant = await c.env.DB.prepare("SELECT tenant_id FROM tenants WHERE email = ?")
        .bind(link.email)
        .first<{ tenant_id: number }>();
      const tenantId = tenant!.tenant_id;

      await c.env.DB.prepare(
        "INSERT INTO members (id, tenant_id, email, preferred_location, created_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(memberId, tenantId, link.email, "global", now)
        .run();

      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
        }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
         .catch((e) => console.error("Tenant DB provisioning failed:", e))
      );

      member = { id: memberId, tenant_id: tenantId, email: link.email, preferred_location: "global", language: "en" };
    }

    const sessions = new SessionService(c.env.KV);
    const sessionId = await sessions.create(member.id, member.tenant_id, member.email, member.language || "en");

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });

    return c.json({
      ok: true,
      member: { id: member.id, email: member.email, preferred_location: member.preferred_location, language: member.language || "en" },
      tenant: { id: member.tenant_id, email: member.email },
    });
  });

  router.post("/logout", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (sessionId) {
      const sessions = new SessionService(c.env.KV);
      await sessions.destroy(sessionId);
    }
    deleteCookie(c, "session", { path: "/", domain: "uni-scrm.com" });
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

    const sessions = new SessionService(c.env.KV);
    const session = await sessions.get(sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const member = await c.env.DB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language FROM members WHERE id = ?"
    )
      .bind(session.member_id)
      .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string }>();
    if (!member) return c.json({ error: "Unauthorized" }, 401);

    return c.json({
      member: { id: member.id, email: member.email, preferred_location: member.preferred_location, language: member.language || "en" },
      tenant: { id: member.tenant_id, email: member.email },
    });
  });

  return router;
}
