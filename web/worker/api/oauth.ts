import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { Google, Twitter, generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import type { Env } from "../types";
import { OAuthService } from "../services/oauth";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";
import { X_CHANNEL_SCOPES } from "../../../link/src/oauth";

export function createOAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/google", async (c) => {
    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.WEB_URL}/api/auth/google/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const sessionId = getCookie(c, "session");
    const sessions = new SessionService(c.env.WEB_DB);
    const session = sessionId ? await sessions.get(sessionId) : null;
    const mode = c.req.query("link") === "true" && session ? "link" as const : "login" as const;
    const trial = c.req.query("trial");
    const timezone = c.req.query("timezone");

    await oauthService.storeState(state, {
      codeVerifier,
      mode,
      userId: session?.member_id,
      trial: trial || undefined,
      timezone: timezone || undefined,
    });

    return c.redirect(url.toString());
  });

  router.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const stored = await oauthService.getState(state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);

    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.WEB_URL}/api/auth/google/callback`);
    const tokens = await google.validateAuthorizationCode(code, stored.codeVerifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email: string };
    const email = claims.email;
    const sub = claims.sub;

    if (stored.mode === "link" && stored.userId) {
      const member = await c.env.WEB_DB.prepare("SELECT tenant_id FROM members WHERE id = ?")
        .bind(stored.userId)
        .first<{ tenant_id: string }>();
      await oauthService.linkAccount(stored.userId, member!.tenant_id, "google", sub);
      return c.redirect("/settings");
    }

    const { memberId, tenantId, isNew } = await oauthService.resolveUser("google", sub, email, stored.timezone || "UTC");
    if (isNew) {
      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
        }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
         .catch((e) => console.error("Tenant DB provisioning failed:", e))
      );
      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/subscriptions/activate-trial`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: tenantId, tier: "basic", days: 30 }),
        }).catch((e) => console.error("Trial activation failed:", e))
      );
    }
    const sessions = new SessionService(c.env.WEB_DB);
    const newSessionId = await sessions.create(memberId, tenantId, email);

    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
    return c.html(`<!DOCTYPE html><html><head><script>document.cookie="session=;path=/;max-age=0;secure";document.cookie="session=;path=/;domain=uni-scrm.com;max-age=0;secure";document.cookie="session=${newSessionId};path=/;max-age=${7*24*60*60};secure;samesite=lax;domain=uni-scrm.com";window.location.replace("/")</script></head><body></body></html>`);
  });

  router.get("/x", async (c) => {
    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.WEB_URL}/api/auth/x/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = twitter.createAuthorizationURL(state, codeVerifier, X_CHANNEL_SCOPES);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const sessionId = getCookie(c, "session");
    const sessions = new SessionService(c.env.WEB_DB);
    const session = sessionId ? await sessions.get(sessionId) : null;
    const mode = c.req.query("link") === "true" && session ? "link" as const : "login" as const;
    const trial = c.req.query("trial");
    const timezone = c.req.query("timezone");

    await oauthService.storeState(state, {
      codeVerifier,
      mode,
      userId: session?.member_id,
      trial: trial || undefined,
      timezone: timezone || undefined,
    });

    return c.redirect(url.toString());
  });

  router.get("/x/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const stored = await oauthService.getState(state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);

    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.WEB_URL}/api/auth/x/callback`);
    const tokens = await twitter.validateAuthorizationCode(code, stored.codeVerifier);

    const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const userData = await userRes.json() as { data: { id: string; name: string; username: string } };
    const xUserId = userData.data.id;

    let expiresAt: string;
    try {
      expiresAt = new Date(Date.now() + tokens.accessTokenExpiresInSeconds() * 1000).toISOString();
    } catch {
      expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
    }

    if (stored.mode === "link" && stored.userId) {
      const member = await c.env.WEB_DB.prepare("SELECT tenant_id FROM members WHERE id = ?")
        .bind(stored.userId)
        .first<{ tenant_id: number }>();
      await oauthService.linkAccount(stored.userId, String(member!.tenant_id), "x", xUserId);

      c.executionCtx.waitUntil(
        fetch(`${c.env.LINK_URL}/internal/channels/create-x`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: member!.tenant_id, member_id: stored.userId, access_token: tokens.accessToken(), refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null, expires_at: expiresAt }),
        }).catch((e) => console.error("X channel creation failed:", e))
      );

      return c.redirect("/settings");
    }

    const emailRes = await fetch("https://api.x.com/2/users/me?user.fields=email", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const emailData = await emailRes.json() as { data: { email?: string } };
    const email = emailData.data?.email;

    if (email) {
      const { memberId, tenantId, isNew } = await oauthService.resolveUser("x", xUserId, email, stored.timezone || "UTC");
      if (isNew) {
        c.executionCtx.waitUntil(
          fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
            method: "POST",
            headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
          }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
           .catch((e) => console.error("Tenant DB provisioning failed:", e))
        );
        c.executionCtx.waitUntil(
          fetch(`${c.env.ADMIN_URL}/internal/subscriptions/activate-trial`, {
            method: "POST",
            headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
            body: JSON.stringify({ tenant_id: tenantId, tier: "basic", days: 30 }),
          }).catch((e) => console.error("Trial activation failed:", e))
        );
      }

      c.executionCtx.waitUntil(
        fetch(`${c.env.LINK_URL}/internal/channels/create-x`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: tenantId, member_id: memberId, access_token: tokens.accessToken(), refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null, expires_at: expiresAt }),
        }).then((r) => r.json()).then((d) => console.log("X channel created:", JSON.stringify(d)))
         .catch((e) => console.error("X channel creation failed:", e))
      );

      const sessions = new SessionService(c.env.WEB_DB);
      const newSessionId = await sessions.create(memberId, tenantId, email);

      setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
      setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
      return c.html(`<!DOCTYPE html><html><head><script>document.cookie="session=;path=/;max-age=0;secure";document.cookie="session=;path=/;domain=uni-scrm.com;max-age=0;secure";document.cookie="session=${newSessionId};path=/;max-age=${7*24*60*60};secure;samesite=lax;domain=uni-scrm.com";window.location.replace("/")</script></head><body></body></html>`);
    }

    // No email — store pending with tokens and redirect to complete-profile
    const pendingId = crypto.randomUUID();
    await oauthService.storePendingOAuth(pendingId, {
      provider: "x",
      providerUserId: xUserId,
      access_token: tokens.accessToken(),
      refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
      expires_at: expiresAt,
    });
    setCookie(c, "pending_oauth", pendingId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 600,
      path: "/",
    });
    return c.redirect("/auth/complete-profile");
  });

  router.post("/complete-profile", async (c) => {
    const pendingId = getCookie(c, "pending_oauth");
    if (!pendingId) return c.json({ error: "No pending OAuth session" }, 400);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const pending = await oauthService.getPendingOAuth(pendingId);
    if (!pending) return c.json({ error: "Pending session expired" }, 400);

    const { email } = await c.req.json<{ email: string }>();
    if (!email) return c.json({ error: "Email is required" }, 400);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await c.env.KV.put(`email_code:${email}`, JSON.stringify({ code, attempts: 0 }), {
      expirationTtl: 600,
    });

    const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.WEB_URL);
    await emailService.sendVerificationCode(email, code);

    return c.json({ ok: true });
  });


  router.post("/verify-code", async (c) => {
    const pendingId = getCookie(c, "pending_oauth");
    if (!pendingId) return c.json({ error: "No pending OAuth session" }, 400);

    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const pending = await oauthService.getPendingOAuth(pendingId);
    if (!pending) return c.json({ error: "Pending session expired" }, 400);

    const { email, code } = await c.req.json<{ email: string; code: string }>();

    const raw = await c.env.KV.get(`email_code:${email}`);
    if (!raw) return c.json({ error: "Code expired" }, 400);

    const stored = JSON.parse(raw) as { code: string; attempts: number };
    if (stored.attempts >= 3) {
      await c.env.KV.delete(`email_code:${email}`);
      return c.json({ error: "Too many attempts" }, 400);
    }

    if (stored.code !== code) {
      stored.attempts++;
      await c.env.KV.put(`email_code:${email}`, JSON.stringify(stored), { expirationTtl: 600 });
      return c.json({ error: "Invalid code" }, 400);
    }

    await c.env.KV.delete(`email_code:${email}`);
    const { memberId, tenantId, isNew } = await oauthService.resolveUser(pending.provider, pending.providerUserId, email, "UTC");
    await oauthService.deletePendingOAuth(pendingId);
    if (isNew) {
      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
        }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
         .catch((e) => console.error("Tenant DB provisioning failed:", e))
      );
    }

    if (pending.provider === "x" && pending.access_token) {
      c.executionCtx.waitUntil(
        fetch(`${c.env.LINK_URL}/internal/channels/create-x`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: tenantId, member_id: memberId, access_token: pending.access_token, refresh_token: pending.refresh_token, expires_at: pending.expires_at }),
        }).then((r) => r.json()).then((d) => console.log("X channel created:", JSON.stringify(d)))
         .catch((e) => console.error("X channel creation failed:", e))
      );
    }

    const sessions = new SessionService(c.env.WEB_DB);
    const newSessionId = await sessions.create(memberId, tenantId, email);
    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
    setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
    setCookie(c, "session", newSessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });

    return c.json({
      ok: true,
      member: { id: memberId, email },
      tenant: { id: tenantId, email },
    });
  });

  return router;
}
