import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { Twitter, generateState, generateCodeVerifier } from "arctic";
import type { Env, Session } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { ContentService } from "./services/content";
import { TikTokChannel } from "./channels/tiktok";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";

import { X_CHANNEL_SCOPES } from "../../shared/x-scopes";
export { X_CHANNEL_SCOPES };

async function resolveSession(c: Context<{ Bindings: Env }>): Promise<{ tenant_id: number; member_id: string } | null> {
  const sessionId = getCookie(c, "session");
  if (!sessionId) return null;
  const kvData = await c.env.KV.get(`session:${sessionId}`);
  if (kvData) {
    const session = JSON.parse(kvData) as Session;
    return { tenant_id: session.tenant_id, member_id: session.member_id };
  }
  const dbRow = await c.env.WEB_DB
    .prepare("SELECT tenant_id, member_id FROM sessions WHERE id = ? AND expires_at > datetime('now')")
    .bind(sessionId)
    .first<{ tenant_id: number; member_id: string }>();
  return dbRow || null;
}

export function oauthRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // X OAuth PKCE connect
  router.get("/x/connect", async (c) => {
    const session = await resolveSession(c);
    const tenantId = session ? String(session.tenant_id) : null;
    const memberId = session?.member_id || null;
    const byokChannelId = c.req.query("channelId") || null;

    const url = new URL(c.req.url);
    let clientId = c.env.X_CLIENT_ID;
    let clientSecret = c.env.X_CLIENT_SECRET;

    if (byokChannelId) {
      const row = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE id = ? AND is_active = 1")
        .bind(byokChannelId)
        .first<{ config: string }>();
      if (!row) return c.json({ error: "Channel not found" }, 404);
      const config = JSON.parse(row.config) as ByokConfig;
      const creds = await getAppCredentials(c.env, config);
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
    }

    const twitter = new Twitter(clientId, clientSecret, `${url.origin}/api/auth/x/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const arcticUrl = twitter.createAuthorizationURL(state, codeVerifier, X_CHANNEL_SCOPES);
    const oauthUrl = new URL(arcticUrl.toString().replace("https://twitter.com/", "https://x.com/"));

    await c.env.KV.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier, tenantId, memberId, byokChannelId }), { expirationTtl: 300 });
    return c.redirect(oauthUrl.toString(), 302);
  });

  // X OAuth callback
  router.get("/x/callback", async (c) => {
    try {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await c.env.KV.get(`oauth_state:${state}`);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    await c.env.KV.delete(`oauth_state:${state}`);
    const { codeVerifier, tenantId, memberId, byokChannelId } = JSON.parse(stored) as {
      codeVerifier: string; tenantId?: string; memberId?: string; byokChannelId?: string;
    };

    let clientId = c.env.X_CLIENT_ID;
    let clientSecret = c.env.X_CLIENT_SECRET;

    if (byokChannelId) {
      const row = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE id = ? AND is_active = 1")
        .bind(byokChannelId)
        .first<{ config: string }>();
      if (row) {
        const cfg = JSON.parse(row.config) as ByokConfig;
        const creds = await getAppCredentials(c.env, cfg);
        clientId = creds.clientId;
        clientSecret = creds.clientSecret;
      }
    }

    const twitter = new Twitter(clientId, clientSecret, `${url.origin}/api/auth/x/callback`);
    let tokens;
    try {
      tokens = await twitter.validateAuthorizationCode(code, codeVerifier);
    } catch (e) {
      console.error(JSON.stringify({ event: "x_oauth_token_exchange_failed", error: String(e), byokChannelId }));
      return c.json({ error: `Token exchange failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }

    const userRes = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error(JSON.stringify({ event: "x_oauth_user_fetch_failed", status: userRes.status, body: errText }));
      return c.json({ error: `Failed to fetch user: ${userRes.status}` }, 400);
    }
    const userData = await userRes.json() as { data: { id: string; name: string; username: string } };
    const xUser = userData.data;

    let expiresAt: string;
    try {
      expiresAt = new Date(Date.now() + tokens.accessTokenExpiresInSeconds() * 1000).toISOString();
    } catch {
      expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
    }

    if (byokChannelId) {
      // BYOK: update existing channel with user tokens
      const existingRow = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE id = ?")
        .bind(byokChannelId)
        .first<{ config: string }>();
      const existingConfig = existingRow ? JSON.parse(existingRow.config) : {};
      const updatedConfig = JSON.stringify({
        ...existingConfig,
        x_user_id: xUser.id,
        x_username: xUser.username,
        x_name: xUser.name,
        access_token: tokens.accessToken(),
        refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
        expires_at: expiresAt,
      });

      await c.env.LINK_DB
        .prepare(`UPDATE channels SET config = ?, source_channel_id = ?, access_token = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(updatedConfig, xUser.id, tokens.accessToken(), byokChannelId)
        .run();

      // Seed (or reset, on re-authorization) followers poll state — full backfill runs again
      await c.env.LINK_DB
        .prepare(
          `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
           VALUES (?, 'followers', NULL, 0, NULL, datetime('now'))
           ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
        )
        .bind(byokChannelId)
        .run();

      // Setup subscriptions using BYOK channel's own webhook URL
      const tokenService = new XTokenService(c.env.LINK_DB, clientId, clientSecret);
      try {
        const webhookUrl = `${url.origin}/x/webhook/${byokChannelId}`;
        const userService = new XActivityService(tokens.accessToken());
        const ids = await userService.setupAllSubscriptions(xUser.id, webhookUrl);
        await tokenService.updateConfig(byokChannelId, { subscription_ids: ids });
      } catch (e) {
        console.error("BYOK XAA subscription setup failed:", e);
      }
    } else {
      // System App: existing flow
      const config = JSON.stringify({
        x_user_id: xUser.id,
        x_username: xUser.username,
        x_name: xUser.name,
        access_token: tokens.accessToken(),
        refresh_token: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
        expires_at: expiresAt,
      });

      const channelId = crypto.randomUUID();
      await c.env.LINK_DB
        .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
           VALUES (?, 'X', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`)
        .bind(channelId, config, xUser.id, tokens.accessToken(), tenantId || null, memberId || null)
        .run();

      const row = await c.env.LINK_DB
        .prepare(`SELECT id FROM channels WHERE channel_type IN ('X', 'TWITTER') AND source_channel_id = ? AND is_active = 1`)
        .bind(xUser.id)
        .first<{ id: string }>();
      const actualChannelId = row?.id || channelId;

      const tokenService = new XTokenService(c.env.LINK_DB, clientId, clientSecret);
      try {
        const webhookUrl = `${url.origin}/x/webhook`;
        const bearerService = new XActivityService(c.env.X_BEARER_TOKEN);
        let webhook = await bearerService.getWebhook();
        if (!webhook || webhook.url !== webhookUrl) {
          const whId = await bearerService.createWebhook(webhookUrl);
          webhook = { webhook_id: whId, url: webhookUrl };
        }
        const userService = new XActivityService(tokens.accessToken());
        const ids = await userService.setupAllSubscriptions(xUser.id, webhookUrl, webhook.webhook_id);
        await tokenService.updateConfig(actualChannelId, { subscription_ids: ids });
      } catch (e) {
        console.error("XAA subscription setup failed:", e);
      }
    }

    return c.redirect(url.origin, 302);
    } catch (e) {
      console.error(JSON.stringify({ event: "x_oauth_callback_error", error: String(e), stack: e instanceof Error ? e.stack : undefined }));
      return c.json({ error: `OAuth callback failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  });

  // TikTok OAuth connect
  router.get("/tiktok/connect", async (c) => {
    const session = await resolveSession(c);
    const tenantId = session ? String(session.tenant_id) : null;
    const memberId = session?.member_id || null;

    const url = new URL(c.req.url);
    const state = crypto.randomUUID();
    await c.env.KV.put(`oauth_state:${state}`, JSON.stringify({ tenantId, memberId, provider: "tiktok" }), { expirationTtl: 300 });

    const redirectUri = encodeURIComponent(`${url.origin}/api/auth/tiktok/callback`);
    const tiktokUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${c.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.list&response_type=code&redirect_uri=${redirectUri}&state=${state}`;
    return c.redirect(tiktokUrl, 302);
  });

  // TikTok OAuth callback
  router.get("/tiktok/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await c.env.KV.get(`oauth_state:${state}`);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    await c.env.KV.delete(`oauth_state:${state}`);
    const { tenantId, memberId } = JSON.parse(stored) as { tenantId?: string; memberId?: string };

    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: c.env.TIKTOK_CLIENT_KEY,
        client_secret: c.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${url.origin}/api/auth/tiktok/callback`,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return c.json({ error: `Token exchange failed: ${err}` }, 400);
    }

    const tokenData = (await tokenRes.json()) as {
      open_id: string;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const userRes = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userDataRes = (await userRes.json()) as { data?: { user?: { open_id: string; display_name: string; avatar_url?: string } } };
    const tiktokUser = userDataRes.data?.user;

    const openId = tiktokUser?.open_id || tokenData.open_id;
    const displayName = tiktokUser?.display_name || "";
    const avatarUrl = tiktokUser?.avatar_url || "";

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : new Date(Date.now() + 86400 * 1000).toISOString();

    const config = JSON.stringify({
      open_id: openId,
      display_name: displayName,
      avatar_url: avatarUrl,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: expiresAt,
    });

    const channelId = crypto.randomUUID();
    await c.env.LINK_DB
      .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'TIKTOK', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`)
      .bind(channelId, config, openId, tokenData.access_token, tenantId ? parseInt(tenantId) : null, memberId || null)
      .run();

    // Trigger TikTok content sync (now local function call)
    try {
      const parsedTenantId = tenantId ? parseInt(tenantId) : null;
      if (parsedTenantId) {
        const tenant = await c.env.WEB_DB
          .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
          .bind(parsedTenantId)
          .first<{ d1_database_id: string | null }>();
        if (tenant?.d1_database_id) {
          const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenant.d1_database_id);
          const tiktok = new TikTokChannel(tokenData.access_token);
          const items = await tiktok.fetchItems({});
          if (items.length > 0) {
            const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, parsedTenantId);
            await contentService.syncBatch("TIKTOK", items);
          }
        }
      }
    } catch (e) {
      console.error("TikTok content sync failed:", e);
    }

    return c.redirect(url.origin, 302);
  });

  return router;
}
