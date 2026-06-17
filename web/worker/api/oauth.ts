import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { Google, Twitter, generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import type { Env } from "../types";
import { OAuthService } from "../services/oauth";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";

export function createOAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/google", async (c) => {
    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/google/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const sessionId = getCookie(c, "session");
    const sessions = new SessionService(c.env.KV);
    const session = sessionId ? await sessions.get(sessionId) : null;
    const mode = c.req.query("link") === "true" && session ? "link" as const : "login" as const;

    await oauthService.storeState(state, {
      codeVerifier,
      mode,
      userId: session?.member_id,
    });

    return c.redirect(url.toString());
  });

  router.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const stored = await oauthService.getState(state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);

    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/google/callback`);
    const tokens = await google.validateAuthorizationCode(code, stored.codeVerifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email: string };
    const email = claims.email;
    const sub = claims.sub;

    if (stored.mode === "link" && stored.userId) {
      const member = await c.env.DB.prepare("SELECT tenant_id FROM members WHERE id = ?")
        .bind(stored.userId)
        .first<{ tenant_id: string }>();
      await oauthService.linkAccount(stored.userId, member!.tenant_id, "google", sub);
      return c.redirect("/settings");
    }

    const { memberId, tenantId, isNew } = await oauthService.resolveUser("google", sub, email);
    if (isNew) {
      c.executionCtx.waitUntil(
        fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
          method: "POST",
          headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
        }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
         .catch((e) => console.error("Tenant DB provisioning failed:", e))
      );
    }
    const sessions = new SessionService(c.env.KV);
    const newSessionId = await sessions.create(memberId, tenantId, email);

    setCookie(c, "session", newSessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });

    return c.redirect("/");
  });

  router.get("/x", async (c) => {
    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/x/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = twitter.createAuthorizationURL(state, codeVerifier, ["tweet.read", "users.read"]);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const sessionId = getCookie(c, "session");
    const sessions = new SessionService(c.env.KV);
    const session = sessionId ? await sessions.get(sessionId) : null;
    const mode = c.req.query("link") === "true" && session ? "link" as const : "login" as const;

    await oauthService.storeState(state, {
      codeVerifier,
      mode,
      userId: session?.member_id,
    });

    return c.redirect(url.toString());
  });

  router.get("/x/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const stored = await oauthService.getState(state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);

    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/x/callback`);
    const tokens = await twitter.validateAuthorizationCode(code, stored.codeVerifier);

    const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const userData = await userRes.json() as { data: { id: string; name: string; username: string } };
    const xUserId = userData.data.id;

    if (stored.mode === "link" && stored.userId) {
      const member = await c.env.DB.prepare("SELECT tenant_id FROM members WHERE id = ?")
        .bind(stored.userId)
        .first<{ tenant_id: string }>();
      await oauthService.linkAccount(stored.userId, member!.tenant_id, "x", xUserId);
      return c.redirect("/settings");
    }

    // Try to get email from X
    const emailRes = await fetch("https://api.x.com/2/users/me?user.fields=email", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const emailData = await emailRes.json() as { data: { email?: string } };
    const email = emailData.data?.email;

    if (email) {
      const { memberId, tenantId, isNew } = await oauthService.resolveUser("x", xUserId, email);
      if (isNew) {
        c.executionCtx.waitUntil(
          fetch(`${c.env.ADMIN_URL}/internal/tenants/${tenantId}/provision-db`, {
            method: "POST",
            headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
          }).then((r) => r.json()).then((d) => console.log("Tenant DB provisioned:", JSON.stringify(d)))
           .catch((e) => console.error("Tenant DB provisioning failed:", e))
        );
      }
      const sessions = new SessionService(c.env.KV);
      const newSessionId = await sessions.create(memberId, tenantId, email);
      setCookie(c, "session", newSessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 7 * 24 * 60 * 60,
        path: "/",
        domain: "uni-scrm.com",
      });
      return c.redirect("/");
    }

    // No email — store pending and redirect to complete-profile
    const pendingId = crypto.randomUUID();
    await oauthService.storePendingOAuth(pendingId, { provider: "x", providerUserId: xUserId });
    setCookie(c, "pending_oauth", pendingId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 300,
      path: "/",
    });
    return c.redirect("/auth/complete-profile");
  });

  router.post("/complete-profile", async (c) => {
    const pendingId = getCookie(c, "pending_oauth");
    if (!pendingId) return c.json({ error: "No pending OAuth session" }, 400);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const pending = await oauthService.getPendingOAuth(pendingId);
    if (!pending) return c.json({ error: "Pending session expired" }, 400);

    const { email } = await c.req.json<{ email: string }>();
    if (!email) return c.json({ error: "Email is required" }, 400);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await c.env.KV.put(`email_code:${email}`, JSON.stringify({ code, attempts: 0 }), {
      expirationTtl: 600,
    });

    const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.APP_URL);
    await emailService.sendVerificationCode(email, code);

    return c.json({ ok: true });
  });

  router.get("/x/channel", async (c) => {
    const sessionId = getCookie(c, "session");
    const sessions = new SessionService(c.env.KV);
    const session = sessionId ? await sessions.get(sessionId) : null;
    if (!session) return c.json({ error: "Not authenticated" }, 401);

    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/x/channel/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const arcticUrl = twitter.createAuthorizationURL(state, codeVerifier, [
      "tweet.read", "users.read", "follows.read", "tweet.write", "offline.access",
    ]);
    // Replace twitter.com with x.com (arctic hardcodes twitter.com but cookies live on x.com)
    const url = new URL(arcticUrl.toString().replace("https://twitter.com/", "https://x.com/"));

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    await oauthService.storeState(state, {
      codeVerifier,
      mode: "channel" as const,
      userId: session.member_id,
    });

    return c.redirect(url.toString());
  });

  router.get("/x/channel/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const stored = await oauthService.getState(state);
    if (!stored || stored.mode !== "channel" || !stored.userId) {
      return c.json({ error: "Invalid state" }, 400);
    }

    const twitter = new Twitter(c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET, `${c.env.APP_URL}/api/auth/x/channel/callback`);
    const tokens = await twitter.validateAuthorizationCode(code, stored.codeVerifier);

    const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const userData = await userRes.json() as { data: { id: string; name: string; username: string; profile_image_url?: string } };
    const xUser = userData.data;

    const channelId = crypto.randomUUID();
    let expiresAt: string | null = null;
    try {
      const expiresIn = tokens.accessTokenExpiresInSeconds();
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    } catch {
      expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
    }
    const config = JSON.stringify({
      x_user_id: xUser.id,
      x_username: xUser.username,
      x_name: xUser.name,
      access_token: tokens.accessToken(),
      refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
      expires_at: expiresAt,
    });

    await c.env.DB
      .prepare(
        `INSERT INTO channels (id, user_id, channel_type, config, created_at, updated_at)
         VALUES (?, ?, 'TWITTER', ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, channel_type) DO UPDATE SET
           config = excluded.config, updated_at = datetime('now')`
      )
      .bind(channelId, stored.userId, config)
      .run();

    const row = await c.env.DB
      .prepare(`SELECT id FROM channels WHERE user_id = ? AND channel_type = 'TWITTER'`)
      .bind(stored.userId)
      .first<{ id: string }>();
    const actualChannelId = row?.id || channelId;

    // Trigger link-social to fetch followers and register webhook
    c.executionCtx.waitUntil(
      fetch(`${c.env.LINK_SOCIAL_URL}/x/sync-followers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({
          channel_id: actualChannelId,
          x_user_id: xUser.id,
          access_token: tokens.accessToken(),
        }),
      }).catch(() => {})
    );

    return c.redirect("/settings");
  });

  router.post("/verify-code", async (c) => {
    const pendingId = getCookie(c, "pending_oauth");
    if (!pendingId) return c.json({ error: "No pending OAuth session" }, 400);

    const oauthService = new OAuthService(c.env.DB, c.env.KV);
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
    const { memberId, tenantId, isNew } = await oauthService.resolveUser(pending.provider, pending.providerUserId, email);
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

    const sessions = new SessionService(c.env.KV);
    const newSessionId = await sessions.create(memberId, tenantId, email);
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
