import { Hono, type Context } from "hono";
import { resolveSession as resolveSharedSession } from "../../shared/auth";
import { storeOAuthState, consumeOAuthState } from "../../shared/oauth-state";
import { Twitter, Google, generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService, byokWebhookUrl } from "./services/x-webhook";
import { describeTenant } from "./services/tenant-label";
import { getAppCredentials, X_BYOK_SCOPES, type ByokConfig } from "./services/app-credentials";
import { pollChannelOnce } from "./services/pollers/poll-channel";
import { syncYouTubeSubscriptionUsers } from "./services/youtube-account";
import { getActiveSubscriptionTier } from "../../shared/credit-service";
import { canUseFeature, LOWEST_TIER } from "../../shared/plans";

import { X_CHANNEL_SCOPES } from "../../shared/x-scopes";
export { X_CHANNEL_SCOPES };

// Thin adapter over shared/auth.ts's single session implementation (the previous inline
// copy here also carried a dead KV-first branch — sessions are D1-only). Keeps the
// snake_case shape this file's call sites have always used.
async function resolveSession(c: Context<{ Bindings: Env }>): Promise<{ tenant_id: number; member_id: string } | null> {
  const session = await resolveSharedSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  return session ? { tenant_id: session.tenantId, member_id: session.memberId } : null;
}

export function buildYouTubeAuthUrl(clientId: string, clientSecret: string, redirectUri: string): {
  url: URL; state: string; codeVerifier: string;
} {
  const google = new Google(clientId, clientSecret, redirectUri);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ]);
  // access_type=offline + prompt=consent are BOTH required for Google to return a refresh
  // token. select_account keeps the account chooser so a tenant can connect a different
  // Google account after disconnecting.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  return { url, state, codeVerifier };
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
      // channelId is caller-supplied, so the lookup must be tenant-scoped: an
      // unscoped one would decrypt another tenant's BYOK app credentials and put
      // their client_id into the authorization URL we hand back, and the callback
      // would then write the caller's X account into that tenant's channel row.
      // 404 (not 403) so the response can't be used to probe which ids exist.
      if (!session) return c.json({ error: "Must be logged in to connect a BYOK app" }, 401);
      const row = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND is_active = 1")
        .bind(byokChannelId, session.tenant_id)
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
    const scopes = byokChannelId ? X_BYOK_SCOPES : X_CHANNEL_SCOPES;
    const arcticUrl = twitter.createAuthorizationURL(state, codeVerifier, scopes);
    const oauthUrl = new URL(arcticUrl.toString().replace("https://twitter.com/", "https://x.com/"));

    await storeOAuthState(c.env.WEB_DB, state, { codeVerifier, tenantId, memberId, byokChannelId });
    return c.redirect(oauthUrl.toString(), 302);
  });

  // X OAuth callback
  router.get("/x/callback", async (c) => {
    try {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await consumeOAuthState<{
      codeVerifier: string; tenantId?: string; memberId?: string; byokChannelId?: string;
    }>(c.env.WEB_DB, state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    const { codeVerifier, tenantId, memberId, byokChannelId } = stored;

    let clientId = c.env.X_CLIENT_ID;
    let clientSecret = c.env.X_CLIENT_SECRET;
    // App-only auth for `/2/webhooks`, kept separate from the user token below.
    let bearerToken: string | undefined = c.env.X_BEARER_TOKEN;

    if (byokChannelId) {
      // /x/connect already proved this channel belongs to the session's tenant
      // before writing the state, but the whole BYOK branch below writes tokens
      // into this row by id — so re-check ownership here rather than trusting
      // that a state blob and its channel id were paired by us.
      if (!tenantId) return c.json({ error: "Must be logged in to connect a BYOK app" }, 401);
      const row = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND is_active = 1")
        .bind(byokChannelId, Number(tenantId))
        .first<{ config: string }>();
      if (!row) return c.json({ error: "Channel not found" }, 404);
      const cfg = JSON.parse(row.config) as ByokConfig;
      const creds = await getAppCredentials(c.env, cfg);
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
      // Undefined for a BYOK channel saved before the field existed — the authorize itself
      // still succeeds; only webhook registration below reports the gap.
      bearerToken = creds.bearerToken;
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
        .prepare("SELECT config, tenant_id FROM channels WHERE id = ?")
        .bind(byokChannelId)
        .first<{ config: string; tenant_id: number | null }>();
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

      // channels has UNIQUE(channel_type, source_channel_id) — this X account may
      // already be tied to a different row (a prior system-app connection, or a
      // duplicate BYOK placeholder from a double-click "Add App"). Free that row's
      // slot (is_active=0, source_channel_id=NULL — NULL never collides in a SQLite
      // unique index, so no migration needed) before claiming the account below.
      const conflictingRow = await c.env.LINK_DB
        .prepare("SELECT id, tenant_id FROM channels WHERE channel_type = 'X' AND source_channel_id = ? AND id != ?")
        .bind(xUser.id, byokChannelId)
        .first<{ id: string; tenant_id: number | null }>();

      if (conflictingRow && conflictingRow.tenant_id !== (existingRow?.tenant_id ?? null)) {
        console.error(JSON.stringify({ event: "x_byok_cross_tenant_conflict", byokChannelId, conflictingChannelId: conflictingRow.id, conflictingTenantId: conflictingRow.tenant_id }));
        // Name the holder: "connected under a different tenant" left the user with nowhere to
        // go — most of the time the other tenant is their OWN second workspace, and they can
        // only disconnect it there if they know which one it is. The owner email is masked
        // because the person hitting this is, by definition, not a member of that tenant.
        return c.json({ error: `This X account is already connected under another tenant (${await describeTenant(c.env.WEB_DB, conflictingRow.tenant_id)}). Disconnect it there first, then authorize again.` }, 409);
      }

      if (conflictingRow) {
        // deactivated_reason distinguishes this from tier-enforcement pauses (see
        // admin/src/routes/webhook.ts) so a later tier upgrade never reactivates it,
        // and records the freed source_channel_id since the column itself is cleared.
        await c.env.LINK_DB
          // tenant-scope-ok: conflictingRow cross-tenant check rejected with 409 above; only same-tenant rows reach here
          .prepare("UPDATE channels SET is_active = 0, source_channel_id = NULL, deactivated_reason = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(`byok_merged source_channel_id=${xUser.id}`, conflictingRow.id)
          .run();
      }

      await c.env.LINK_DB
        // tenant-scope-ok: byokChannelId ownership proven by the tenant-scoped credential lookup earlier in this branch
        .prepare(`UPDATE channels SET config = ?, source_channel_id = ?, access_token = ?, is_byok = 1, is_active = 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(updatedConfig, xUser.id, tokens.accessToken(), byokChannelId)
        .run();

      // Seed (or reset, on re-authorization) poll state — full backfill runs again
      for (const pollerName of ["posts"]) {
        await c.env.LINK_DB
          .prepare(
            `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
             VALUES (?, ?, NULL, 0, NULL, datetime('now'))
             ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
          )
          .bind(byokChannelId, pollerName)
          .run();
      }

      // The channel row itself is already updated above, so the browser can be
      // redirected back immediately — the instant backfill poll and webhook
      // subscription setup below can each take up to the poller's own 20s
      // budget, and awaiting them here would leave the user staring at a
      // blank redirect for that whole time for no benefit (the frontend just
      // re-reads the channel row, not these background side effects).
      const tokenService = new XTokenService(c.env.LINK_DB, clientId, clientSecret);
      c.executionCtx.waitUntil(
        (async () => {
          // Subscriptions FIRST. The instant backfill poll runs two pollers, each with its own
          // 20s budget (pollers/poll-channel.ts PER_CHANNEL_BUDGET_MS), which alone can outlast
          // the whole waitUntil allowance — and it did: on 2026-07-28 the runtime cancelled the
          // tail of this task ("waitUntil() tasks did not complete within the allowed time"),
          // so subscription setup never ran and the channel silently kept the subscription_ids
          // of a previous X app. Subscriptions are the part that cannot self-heal (nothing else
          // ever calls setupAllSubscriptions for an already-populated config); the poll can —
          // the hourly cron re-runs it from the same unfinished cursor.
          try {
            const webhookUrl = byokWebhookUrl(url.origin, xUser.id);
            // Two different credentials, exactly as the system-app branch below does it:
            // `/2/webhooks` only accepts app-only auth (a user token gets 403 "Unsupported
            // Authentication"), while `/2/activity/subscriptions` needs user context for
            // private events. Passing the user token to both is what broke BYOK setup on
            // every authorize until 2026-07-28.
            if (!bearerToken) {
              throw new Error("BYOK channel has no stored bearer token — re-enter the app credentials to register its webhook");
            }
            const bearerService = new XActivityService(bearerToken);
            let webhook = await bearerService.getWebhook(webhookUrl);
            if (!webhook) {
              const whId = await bearerService.createWebhook(webhookUrl);
              webhook = { webhook_id: whId, url: webhookUrl };
            }
            const userService = new XActivityService(tokens.accessToken());
            const ids = await userService.setupAllSubscriptions(xUser.id, webhookUrl, webhook.webhook_id);
            await tokenService.updateConfig(byokChannelId, {
              subscription_ids: ids,
              subscription_error: null,
              subscription_setup_at: new Date().toISOString(),
            });
          } catch (e) {
            console.error("BYOK XAA subscription setup failed:", e);
            // Persist it: this catch is the end of the line for the error otherwise (see
            // ChannelConfig.subscription_error).
            await tokenService
              .updateConfig(byokChannelId, {
                subscription_error: String(e).slice(0, 500),
                subscription_setup_at: new Date().toISOString(),
              })
              .catch((inner) => console.error("recording BYOK setup error failed:", inner));
          }

          try {
            await pollChannelOnce(c.env, "X", byokChannelId);
          } catch (e) {
            console.error("X BYOK instant poll failed:", e);
          }
        })()
      );
    } else {
      // System App: existing flow — abuse-only gate, normal users never reach this
      // because the Connect button is already disabled by tier in the frontend.
      if (tenantId) {
        const sub = await getActiveSubscriptionTier(c.env.ADMIN_DB, Number(tenantId));
        // No active subscription resolves to the cheapest plan, which excludes the official
        // X channel. Previously an absent subscription short-circuited the gate entirely.
        if (!canUseFeature(sub?.tier ?? LOWEST_TIER, "link.x")) {
          return c.json({ error: "forbidden" }, 403);
        }
      }

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
        // tenant-scope-ok: keyed by source_channel_id = the just-OAuth-authenticated X account id, not caller-supplied
        .prepare(`SELECT id FROM channels WHERE channel_type IN ('X', 'TWITTER') AND source_channel_id = ? AND is_active = 1`)
        .bind(xUser.id)
        .first<{ id: string }>();
      const actualChannelId = row?.id || channelId;

      // Same reasoning as the BYOK branch above: don't block the redirect on
      // webhook/subscription setup.
      const tokenService = new XTokenService(c.env.LINK_DB, clientId, clientSecret);
      c.executionCtx.waitUntil(
        (async () => {
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
        })()
      );
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
    await storeOAuthState(c.env.WEB_DB, state, { tenantId, memberId, provider: "tiktok" });

    const redirectUri = encodeURIComponent(`${url.origin}/api/auth/tiktok/callback`);
    const tiktokUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${c.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.list,video.upload&response_type=code&redirect_uri=${redirectUri}&state=${state}`;
    return c.redirect(tiktokUrl, 302);
  });

  // TikTok OAuth callback
  router.get("/tiktok/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await consumeOAuthState<{ tenantId?: string; memberId?: string }>(c.env.WEB_DB, state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    const { tenantId, memberId } = stored;

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

    // On re-authorization, the ON CONFLICT path updates the pre-existing row in
    // place and keeps ITS original id — the freshly-generated channelId above is
    // never actually written to any row. Re-query for the real active row's id,
    // mirroring the X System App connect path's actualChannelId pattern above.
    const tiktokRow = await c.env.LINK_DB
      // tenant-scope-ok: keyed by source_channel_id = the just-OAuth-authenticated TikTok openId, not caller-supplied
      .prepare(`SELECT id FROM channels WHERE channel_type = 'TIKTOK' AND source_channel_id = ? AND is_active = 1`)
      .bind(openId)
      .first<{ id: string }>();
    const actualChannelId = tiktokRow?.id || channelId;

    // Seed (or reset, on re-authorization) poll state for the content poller —
    // full backfill runs again, mirroring the X BYOK callback's pattern.
    await c.env.LINK_DB
      .prepare(
        `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
         VALUES (?, 'content', NULL, 0, NULL, datetime('now'))
         ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
      )
      .bind(actualChannelId)
      .run();

    try {
      await pollChannelOnce(c.env, "TIKTOK", actualChannelId);
    } catch (e) {
      console.error("TikTok instant poll failed:", e);
    }

    return c.redirect(url.origin, 302);
  });

  // GitHub OAuth connect —— 只读公开数据：Watch 列表 (/user/subscriptions) 与 release。
  // 不申请 repo scope：那会顺带拿到私有仓库读权限，授权页上观感很差，而本功能只需要公开
  // repo。副作用是用户 Watch 的私有 repo 不会出现在选择器里，这是有意的取舍。
  router.get("/github/connect", async (c) => {
    const session = await resolveSession(c);
    // 与 YouTube connect 同一道守卫：这个流程只把 channel 挂到已有租户上，没有顺便注册的
    // 分支。不在这里拦，用户走完整个授权流程最后落在一张裸 401 JSON 上，什么都没连上。
    if (!session) return c.json({ error: "Must be logged in to connect GitHub" }, 401);

    const url = new URL(c.req.url);
    const state = crypto.randomUUID();
    await storeOAuthState(c.env.WEB_DB, state, { tenantId: String(session.tenant_id), memberId: session.member_id, provider: "github" });

    const redirectUri = `${url.origin}/api/auth/github/callback`;
    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    // scope 留空 = 只拿公开数据的最小权限。
    authUrl.searchParams.set("scope", "");
    return c.redirect(authUrl.toString(), 302);
  });

  router.get("/github/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await consumeOAuthState<{ tenantId?: string; memberId?: string }>(c.env.WEB_DB, state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    const { tenantId, memberId } = stored;

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/api/auth/github/callback`,
      }),
    });
    if (!tokenRes.ok) return c.json({ error: `Token exchange failed: ${await tokenRes.text()}` }, 400);

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) return c.json({ error: `Token exchange failed: ${tokenData.error || "no access_token"}` }, 400);

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "uniscrm-link",
      },
    });
    if (!userRes.ok) return c.json({ error: `Fetching GitHub user failed: ${await userRes.text()}` }, 400);
    const ghUser = (await userRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };

    // GitHub OAuth App 的 token 默认不过期 —— 没有 refresh_token，也就没有 X/YouTube
    // 那套 token 刷新与冻结逻辑。token 失效只有一种表现：401，见 GitHubUnauthorizedError。
    const config = JSON.stringify({
      login: ghUser.login,
      name: ghUser.name || ghUser.login,
      avatar_url: ghUser.avatar_url || "",
      access_token: tokenData.access_token,
    });

    // 跨租户接管闸门。下面那条 upsert 的 ON CONFLICT(channel_type, source_channel_id) 会把
    // tenant_id 改写成新租户，可 channel_poll_state 的主键是 (channel_id, poller_name)、不带
    // 租户，于是新租户继承了一份 backfill_complete=1 的 seed 状态，而去重表 entity_state 是
    // **按 tenant_id** 存的、对他来说是空的 —— 下一次 cron 会把最新一页上的一百条 release 全
    // 当成新的发出去：真的公开发帖、真的给真人发私信。同一刻原租户的 flow 直接变哑。
    // 所以：同一个 GitHub 账号已经被别的租户连着且仍然 active 时，直接拒绝，不做任何写入。
    // 只挡 GitHub 这一条回调 —— 别的渠道是同样的形状但没有这个 seed 状态错配，动它们是另一件事。
    const owner = await c.env.LINK_DB
      // tenant-scope-ok: 这条查询的目的就是跨租户查重，按 (channel_type, source_channel_id) 唯一键取行
      .prepare("SELECT tenant_id FROM channels WHERE channel_type = 'GITHUB' AND source_channel_id = ? AND is_active = 1")
      .bind(String(ghUser.id))
      .first<{ tenant_id: number | null }>();
    const newTenantId = tenantId ? parseInt(tenantId) : null;
    if (owner && owner.tenant_id !== null && owner.tenant_id !== newTenantId) {
      console.error(JSON.stringify({
        event: "github_channel_cross_tenant_takeover_refused",
        github_user_id: String(ghUser.id), owner_tenant_id: owner.tenant_id, requesting_tenant_id: newTenantId,
      }));
      return c.json({
        error:
          "This GitHub account is already connected by another workspace. Disconnect it there first, or connect a different GitHub account." +
          " / 该 GitHub 账号已被另一个工作区连接。请先在那边断开，或改用另一个 GitHub 账号连接。",
      }, 409);
    }

    const channelId = crypto.randomUUID();
    await c.env.LINK_DB
      // deactivated_reason = NULL：重连就是「已修好」。不清的话，一个健康 channel 上会永远挂着
      // 上一次 401 留下的 'github_unauthorized'，任何按这个字段做的诊断/展示都会读到假状态。
      .prepare(`INSERT INTO channels (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'GITHUB', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, access_token = excluded.access_token, tenant_id = excluded.tenant_id, member_id = excluded.member_id, is_active = 1, deactivated_reason = NULL, updated_at = datetime('now')`)
      .bind(channelId, config, String(ghUser.id), tokenData.access_token, newTenantId, memberId || null)
      .run();

    // 不 seed channel_poll_state：GitHub 的 poll state 是每 (channel, repo) 一行，而 repo
    // 是之后在 flow 节点里选的，连接时还不知道。轮询器首次见到某个 pair 时自行建行
    // （github-releases.ts 的 ensurePollStateRow）。
    return c.redirect(url.origin, 302);
  });

  // YouTube OAuth connect — reuses the same Google Cloud OAuth client already registered
  // for "Sign in with Google" in the web module (GOOGLE_CLIENT_ID/SECRET), not a new one.
  router.get("/youtube/connect", async (c) => {
    const session = await resolveSession(c);
    // Unlike X's system-app connect (which doubles as signup) this flow only ever attaches a
    // channel to an existing tenant — the callback hard-requires tenantId+memberId. Refusing
    // here rather than there is the same guard X's BYOK branch applies: without it an expired
    // session sends the user through Google's whole consent flow (account chooser, unverified-
    // app warning, two clicks) only to land on a raw 401 JSON page with nothing connected.
    if (!session) return c.json({ error: "Must be logged in to connect YouTube" }, 401);
    const tenantId = String(session.tenant_id);
    const memberId = session.member_id;

    const url = new URL(c.req.url);
    const { url: oauthUrl, state, codeVerifier } = buildYouTubeAuthUrl(
      c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${url.origin}/api/auth/youtube/callback`
    );

    await storeOAuthState(c.env.WEB_DB, state, { codeVerifier, tenantId, memberId });
    return c.redirect(oauthUrl.toString(), 302);
  });

  // YouTube OAuth callback
  router.get("/youtube/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await consumeOAuthState<{
      codeVerifier: string; tenantId?: string; memberId?: string;
    }>(c.env.WEB_DB, state);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    const { codeVerifier, tenantId, memberId } = stored;
    if (!tenantId || !memberId) return c.json({ error: "Must be logged in to connect YouTube" }, 401);

    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${url.origin}/api/auth/youtube/callback`);
    let tokens;
    try {
      tokens = await google.validateAuthorizationCode(code, codeVerifier);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_oauth_token_exchange_failed", error: String(e) }));
      return c.json({ error: `Token exchange failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }

    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email: string };
    const googleUserId = claims.sub;
    const email = claims.email;

    // `email` above is the Google *login* identity, not the channel's own name — for a
    // Brand Account (a channel not tied 1:1 to a personal Gmail), Google's OAuth email
    // claim is a synthetic placeholder like "xxxx@pages.plusgoogle.com", not anything a
    // tenant would recognize. Fetch the channel's actual public title the same way the X
    // callback fetches `users/me` for a display name, instead of relying on the ID token.
    let channelTitle: string | null = null;
    // Three-state on purpose: true = this identity owns a channel, false = the API answered
    // but the identity owns none, null = we could not ask (transient failure). Only `false`
    // is grounds to refuse below — a network blip must not block an otherwise valid connect.
    let hasChannel: boolean | null = null;
    try {
      const channelRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      });
      if (channelRes.ok) {
        const channelData = await channelRes.json() as { items?: { snippet?: { title?: string } }[] };
        hasChannel = (channelData.items?.length ?? 0) > 0;
        channelTitle = channelData.items?.[0]?.snippet?.title ?? null;
      } else {
        console.error(JSON.stringify({ event: "youtube_oauth_channel_fetch_failed", status: channelRes.status }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_oauth_channel_fetch_failed", error: String(e) }));
    }

    // Google's account chooser offers every identity signed into the browser plus any Brand
    // Accounts; a Google account with no YouTube channel of its own is a perfectly ordinary
    // choice to land on by mistake, and nothing in that flow says it was wrong. Connecting it
    // anyway produced a channel row with no title and no subscriptions — a card that looks
    // connected and does nothing, with no way for the tenant to tell what they did wrong.
    // Refuse and send them back with a reason instead of writing that row.
    if (hasChannel === false) {
      console.error(JSON.stringify({ event: "youtube_oauth_no_channel", googleUserId, email }));
      return c.redirect(`${url.origin}/channel?youtube_error=no_channel`, 302);
    }

    let expiresAt: string;
    try {
      expiresAt = new Date(Date.now() + tokens.accessTokenExpiresInSeconds() * 1000).toISOString();
    } catch {
      expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    let refreshToken: string | null = null;
    try { refreshToken = tokens.refreshToken(); } catch { refreshToken = null; }

    const sourceChannelId = `${tenantId}:${googleUserId}`;

    if (!refreshToken) {
      // Google only returns refresh_token on the FIRST consent grant for a
      // given scope set — a reconnect where the user already granted consent
      // can omit it even with access_type=offline+prompt=consent. The upsert
      // below is unconditional (config = excluded.config), so without this,
      // a token-omitting reconnect would silently null out a previously
      // working refresh token. Reuse whatever is already stored, if anything.
      //
      // Deliberately NOT filtering "AND is_active = 1" here: disconnect only
      // flips is_active to 0, it does not clear source_channel_id (see the
      // ON CONFLICT comment on the upsert below), and reactivation to 1 only
      // happens inside that same upsert — which runs AFTER this SELECT. So
      // the exact disconnect→reconnect case this exists to protect always has
      // is_active = 0 at this point; filtering on it would find nothing and
      // defeat the whole purpose. Match on source_channel_id alone, mirroring
      // the upsert's own unique index (also unconditional on is_active).
      let preservedRefreshToken: string | null = null;
      const existingChannel = await c.env.LINK_DB
        // tenant-scope-ok: keyed by source_channel_id = the just-OAuth-authenticated YouTube channel id, not caller-supplied
        .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id = ?")
        .bind(sourceChannelId)
        .first<{ config: string }>();
      if (existingChannel?.config) {
        try {
          const existingConfig = JSON.parse(existingChannel.config) as { refresh_token?: string | null };
          preservedRefreshToken = existingConfig.refresh_token ?? null;
        } catch { preservedRefreshToken = null; }
      }
      console.error(JSON.stringify({
        event: "youtube_oauth_refresh_token_absent",
        sourceChannelId,
        preservedPriorToken: !!preservedRefreshToken,
      }));
      refreshToken = preservedRefreshToken;
    }

    const config = {
      google_user_id: googleUserId,
      email,
      channel_title: channelTitle,
      access_token: tokens.accessToken(),
      refresh_token: refreshToken,
      expires_at: expiresAt,
      // config.subscriptions 已删除：订阅的真相是 per-tenant D1 的 user 表（is_follow=1 的
      // YOUTUBE 行），选择器改为实时拉取。留一个永远为空的 key 只会误导下一个读代码的人。
      sync_status: "pending" as const,
      last_synced_at: null as string | null,
    };
    const now = new Date().toISOString();

    // Atomic upsert on (channel_type, source_channel_id) — the table's unique
    // index is unconditional (does not exclude inactive rows), so a prior
    // SELECT-then-branch shape here would violate that index on a plain
    // reconnect after disconnect (disconnect only flips is_active to 0, it
    // does not clear source_channel_id). Mirrors the X System App / TikTok
    // connect paths in this same file.
    const channelId = crypto.randomUUID();
    await c.env.LINK_DB
      .prepare(
        `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'YOUTUBE_ACCOUNT', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, is_active = 1, updated_at = excluded.updated_at`
      )
      .bind(channelId, JSON.stringify(config), sourceChannelId, Number(tenantId), memberId, now, now)
      .run();

    // On reconnect, the ON CONFLICT path updates the pre-existing row in place
    // and keeps its original id — the freshly-generated channelId above is
    // never actually written to that row. Re-query for the real active row's
    // id, mirroring the X System App / TikTok connect paths' actualChannelId
    // pattern above.
    const existing = await c.env.LINK_DB
      // tenant-scope-ok: keyed by source_channel_id = the just-OAuth-authenticated YouTube channel id, not caller-supplied
      .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id = ? AND is_active = 1")
      .bind(sourceChannelId)
      .first<{ id: string }>();
    const actualChannelId = existing?.id || channelId;

    c.executionCtx.waitUntil(syncYouTubeSubscriptionUsers(c.env, actualChannelId));

    return c.redirect(url.origin, 302);
  });

  return router;
}
