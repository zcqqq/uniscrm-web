import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/login", async (c) => {
    const body = await c.req.json<{ email?: string; trial?: string; timezone?: string }>();
    if (!body.email) {
      return c.json({ error: "Email is required" }, 400);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await c.env.DB_WEB.prepare("INSERT INTO magic_links (token, email, expires_at, trial, timezone) VALUES (?, ?, ?, ?, ?)")
      .bind(token, body.email, expiresAt, body.trial ?? null, body.timezone ?? null)
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

    const link = await c.env.DB_WEB.prepare("SELECT * FROM magic_links WHERE token = ?")
      .bind(token)
      .first<{ token: string; email: string; expires_at: string; used: number; trial: string | null; timezone: string | null }>();

    if (!link || link.used || new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await c.env.DB_WEB.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
      .bind(token)
      .run();

    let member = await c.env.DB_WEB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language, timezone FROM members WHERE email = ?"
    )
      .bind(link.email)
      .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string; timezone: string }>();

    if (!member) {
      const memberId = crypto.randomUUID();
      const now = new Date().toISOString();

      await c.env.DB_WEB.prepare("INSERT INTO tenants (email, created_at) VALUES (?, ?)")
        .bind(link.email, now)
        .run();
      const tenant = await c.env.DB_WEB.prepare("SELECT tenant_id FROM tenants WHERE email = ?")
        .bind(link.email)
        .first<{ tenant_id: number }>();
      const tenantId = tenant!.tenant_id;

      const tz = link.timezone || "UTC";
      await c.env.DB_WEB.prepare(
        "INSERT INTO members (id, tenant_id, email, preferred_location, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(memberId, tenantId, link.email, "global", tz, now)
        .run();

      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
        }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
         .catch((e) => console.error("Tenant DB provisioning failed:", e))
      );

      if (link.trial) {
        c.executionCtx.waitUntil(
          fetch(`${c.env.ADMIN_URL}/internal/subscriptions/activate-trial`, {
            method: "POST",
            headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
            body: JSON.stringify({ tenant_id: tenantId, tier: link.trial, days: 30 }),
          }).then((r) => r.json()).then((d) => console.log("Trial activated:", JSON.stringify(d)))
           .catch((e) => console.error("Trial activation failed:", e))
        );
      }

      member = { id: memberId, tenant_id: tenantId, email: link.email, preferred_location: "global", language: "en", timezone: tz };
    }

    const sessions = new SessionService(c.env.DB_WEB);
    const sessionId = await sessions.create(member.id, member.tenant_id, member.email, member.language || "en");

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",

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
      const sessions = new SessionService(c.env.DB_WEB);
      await sessions.destroy(sessionId);
    }
    deleteCookie(c, "session", { path: "/", domain: "uni-scrm.com" });
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const sessionId = getCookie(c, "session");
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

    const sessions = new SessionService(c.env.DB_WEB);
    const session = await sessions.get(sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    const member = await c.env.DB_WEB.prepare(
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
