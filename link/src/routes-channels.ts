import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";
import { ContentService } from "./services/content";
import { NotionChannel } from "./channels/notion";
import { TikTokChannel } from "./channels/tiktok";
import {
  buildShopifyAuthUrl,
  exchangeShopifyCode,
  fetchShopifyProducts,
} from "./channels/shopify";
import { encrypt } from "./services/crypto";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";
import { XTokenService } from "./services/x-token";
import { readFrozenState } from "./services/x-freeze";
import { fetchOwnedLists } from "./services/x-posts-api";
import { YouTubeTokenService } from "./services/youtube-token";
import { fetchAllSubscriptions } from "./services/youtube-api";
import { recordYouTubeQuota } from "./services/youtube-quota";

export function channelsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // List channels by type. type=X also includes the legacy 'TWITTER' alias
  // (pre-migration rows) — every other type queries only its own exact value.
  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const type = (c.req.query("type") || "").toUpperCase();
    const types = type === "X" ? [type, "TWITTER"] : [type];
    const placeholders = types.map(() => "?").join(", ");
    const rows = await c.env.LINK_DB.prepare(
      `SELECT id, config FROM channels WHERE tenant_id = ? AND channel_type IN (${placeholders}) AND is_active = 1`
    ).bind(tenantId, ...types).all<{ id: string; config: string }>();
    const channels = rows.results.map((r) => {
      const config = JSON.parse(r.config || "{}");
      return { id: r.id, username: config.x_username || config.display_name || config.channel_name || "" };
    });
    return c.json(channels);
  });

  // --- X ---
  router.get("/x/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const [row, byokRow] = await Promise.all([
      c.env.LINK_DB
        .prepare("SELECT id, config, created_at FROM channels WHERE tenant_id = ? AND channel_type IN ('TWITTER', 'X') AND is_active = 1 AND (is_byok = 0 OR is_byok IS NULL) LIMIT 1")
        .bind(tenantId)
        .first<{ id: string; config: string; created_at: string }>(),
      c.env.LINK_DB
        .prepare("SELECT id FROM channels WHERE tenant_id = ? AND channel_type = 'X' AND is_active = 1 AND is_byok = 1 LIMIT 1")
        .bind(tenantId)
        .first<{ id: string }>(),
    ]);
    const hasByok = !!byokRow;
    if (!row) return c.json({ connected: false, has_byok: hasByok });
    const config = JSON.parse(row.config) as { x_username?: string };
    // frozen: X has the account locked/suspended and every X call for it is paused until the
    // hourly probe sees it recover (x-freeze.ts). Surfaced so the card can say so — otherwise
    // a connected-looking channel silently does nothing.
    const frozen = readFrozenState(config as Record<string, unknown>);
    return c.json({
      connected: true, username: config.x_username, channel_id: row.id, created_at: row.created_at, has_byok: hasByok,
      frozen_at: frozen?.frozenAt ?? null, frozen_message: frozen?.message ?? null,
    });
  });

  router.get("/x/:channelId/lists", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channelId = c.req.param("channelId");
    const row = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND channel_type = 'X' AND is_active = 1")
      .bind(channelId, tenantId)
      .first<{ config: string }>();
    if (!row) return c.json({ error: "Channel not found" }, 404);

    const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
    if (!config.is_byok || !config.x_user_id) return c.json({ lists: [] });

    try {
      const creds = await getAppCredentials(c.env, config);
      const tokenService = new XTokenService(c.env.LINK_DB, creds.clientId, creds.clientSecret);
      const accessToken = await tokenService.getValidToken(channelId);
      const lists = await fetchOwnedLists(accessToken, config.x_user_id);
      return c.json({ lists });
    } catch (e) {
      console.error(JSON.stringify({ event: "fetch_owned_lists_error", channel_id: channelId, error: String(e) }));
      return c.json({ lists: [] });
    }
  });

  // Disconnects only the system-app connection this tenant sees on the X card.
  // BYOK apps are separate cards with their own DELETE /x/byok/:channelId, so the
  // is_byok predicate keeps this in step with what GET /x/status reports.
  router.delete("/x", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    await c.env.LINK_DB
      .prepare("UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE tenant_id = ? AND channel_type IN ('TWITTER', 'X') AND is_active = 1 AND (is_byok = 0 OR is_byok IS NULL)")
      .bind(tenantId)
      .run();
    return c.json({ ok: true });
  });

  // --- X BYOK ---
  // Handles both creating a new app (channel_id absent, or present-but-unclaimed
  // — the frontend pre-generates the id so it can show the webhook URL before
  // saving) and editing an already-connected app's credentials (channel_id
  // matches an existing row owned by this tenant). Re-authorization after an
  // edit is a separate step (GET /auth/x/connect?channelId=...) since the old
  // OAuth tokens may no longer be valid for the new app credentials.
  router.post("/x/byok", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const body = await c.req.json<{
      channel_id?: string; client_id: string; client_secret: string; consumer_secret: string; bearer_token: string;
    }>();
    const { channel_id } = body;
    // Trim before storing. These are pasted out of the X Developer Console, and a trailing
    // newline survives encryption invisibly — the value then goes into an Authorization header
    // and X answers a bare 401 with nothing to distinguish it from a genuinely wrong token.
    const client_id = body.client_id?.trim();
    const client_secret = body.client_secret?.trim();
    const consumer_secret = body.consumer_secret?.trim();
    const bearer_token = body.bearer_token?.trim();

    // bearer_token is required alongside the other three: `POST /2/webhooks` refuses an
    // OAuth 2.0 user token, so without it the authorize flow silently ends with no webhook
    // and no subscriptions (the 2026-07-28 dev failure). The three older fields cannot
    // substitute — they are user-context or HMAC material, not app-only auth.
    if (!client_id || !client_secret || !consumer_secret || !bearer_token) {
      return c.json({ error: "Missing credentials" }, 400);
    }

    const url = new URL(c.req.url);
    // `is_active = 1` matters: without it this route happily rewrote the credentials of a
    // channel the user had already deleted and answered 200 with a connect URL that then
    // 404s, because GET /x/byok and /x/connect both DO require it. Three views of the same
    // channel disagreeing is what made a delete look like a broken save.
    const existing = channel_id
      ? await c.env.LINK_DB
          .prepare("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND channel_type = 'X' AND is_byok = 1 AND is_active = 1")
          .bind(channel_id, tenantId)
          .first<{ config: string }>()
      : null;

    if (!existing && channel_id) {
      // Not this tenant's channel — reject rather than falling through to
      // INSERT, which would either collide on the primary key or (if some
      // future change made the insert an upsert) silently overwrite someone
      // else's row. Checked before the credential probe below so an authorization
      // failure is never reported as a credential problem (and so a caller poking at
      // someone else's channel id can't use this route to test tokens against X).
      const claimedElsewhere = await c.env.LINK_DB
        // tenant-scope-ok: intentional global probe — detects a channel_id already claimed by ANY tenant before INSERT
        .prepare("SELECT id FROM channels WHERE id = ?")
        .bind(channel_id)
        .first<{ id: string }>();
      if (claimedElsewhere) return c.json({ error: "Channel not found" }, 404);
    }

    // Verify the bearer against the very endpoint it exists for, while a human is still
    // watching. Otherwise a bad token is accepted here and only fails later inside the
    // callback's waitUntil, where nothing surfaces it. Only a 401 is fatal — that is X
    // saying the credential itself is bad. Anything else (403 access tier, 429, 5xx, a
    // network blip) is not evidence about the token, so it must not block saving.
    const probe = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${bearer_token}` },
    }).catch(() => null);
    if (probe && probe.status === 401) {
      return c.json({
        error: "X rejected this Bearer Token (401). Copy it from this app's Keys and tokens page — regenerating it there invalidates the old value.",
      }, 400);
    }
    if (probe && !probe.ok) {
      console.warn(JSON.stringify({
        event: "byok_bearer_probe_non_ok",
        status: probe.status,
        message: "not treated as fatal — only 401 proves a bad credential",
      }));
    }

    const masterKey = await c.env.ENCRYPTION_KEY.get();
    const [encClientId, encClientSecret, encConsumerSecret, encBearerToken] = await Promise.all([
      encrypt(client_id, masterKey),
      encrypt(client_secret, masterKey),
      encrypt(consumer_secret, masterKey),
      encrypt(bearer_token, masterKey),
    ]);

    if (existing) {
      // Editing an existing app: only the credential fields change — everything
      // else (x_user_id, tokens, subscription_ids, ...) is left as-is until the
      // user re-authorizes.
      const updatedConfig = JSON.stringify({
        ...JSON.parse(existing.config),
        is_byok: true,
        app_client_id: encClientId,
        app_client_secret: encClientSecret,
        app_consumer_secret: encConsumerSecret,
        app_bearer_token: encBearerToken,
      });
      await c.env.LINK_DB
        // tenant-scope-ok: `existing` was fetched WHERE id = ? AND tenant_id = ? above; reached only if this tenant owns channel_id
        .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(updatedConfig, channel_id)
        .run();

      return c.json({
        channel_id,
        webhook_url: `${url.origin}/x/webhook/${channel_id}`,
        redirect_url: `${url.origin}/api/auth/x/callback`,
      });
    }

    // The "claimed by another tenant" rejection now happens above, before the credential
    // probe, so this point is only reached for an id this tenant may legitimately insert.
    const channelId = channel_id || crypto.randomUUID();
    const config = JSON.stringify({
      is_byok: true,
      app_client_id: encClientId,
      app_client_secret: encClientSecret,
      app_consumer_secret: encConsumerSecret,
      app_bearer_token: encBearerToken,
    });

    await c.env.LINK_DB
      .prepare(`INSERT INTO channels (id, channel_type, config, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'X', ?, ?, ?, datetime('now'), datetime('now'))`)
      .bind(channelId, config, tenantId, memberId)
      .run();

    return c.json({
      channel_id: channelId,
      webhook_url: `${url.origin}/x/webhook/${channelId}`,
      redirect_url: `${url.origin}/api/auth/x/callback`,
    });
  });

  router.get("/x/byok", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const rows = await c.env.LINK_DB
      .prepare("SELECT id, config, created_at FROM channels WHERE tenant_id = ? AND channel_type = 'X' AND is_active = 1 AND is_byok = 1")
      .bind(tenantId)
      .all<{ id: string; config: string; created_at: string }>();

    const byokChannels = rows.results.map((r) => {
      const cfg = JSON.parse(r.config) as ByokConfig & { x_username?: string; x_user_id?: string };
      const frozen = readFrozenState(cfg as Record<string, unknown>);
      return {
        id: r.id,
        username: cfg.x_username || null,
        x_user_id: cfg.x_user_id || null,
        authorized: !!cfg.x_user_id,
        created_at: r.created_at,
        frozen_at: frozen?.frozenAt ?? null,
        frozen_message: frozen?.message ?? null,
      };
    });

    return c.json(byokChannels);
  });

  router.delete("/x/byok/:channelId", async (c) => {
    const channelId = c.req.param("channelId");
    const tenantId = c.get("tenantId" as never) as number;
    await c.env.LINK_DB
      .prepare("UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?")
      .bind(channelId, tenantId)
      .run();
    return c.json({ ok: true });
  });

  // --- TikTok ---
  router.post("/tiktok/sync", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    // Per-tenant D1 — the source of truth (2026-07-26 plan). authMiddleware only sets this when
    // tenants.d1_database_id is provisioned — absence means "not provisioned", not an error.
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

    const channel = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'TIKTOK' AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!channel) return c.json({ error: "TikTok channel not connected" }, 400);

    const config = JSON.parse(channel.config) as { access_token?: string };
    if (!config.access_token) return c.json({ error: "TikTok token missing" }, 400);

    const tiktok = new TikTokChannel(config.access_token);
    const items = await tiktok.fetchItems({});

    const contentService = new ContentService(tenantDb, c.env.VECTORIZE, c.env.AI, tenantId, c.env.PIPELINE_CONTENT);
    const result = await contentService.syncBatch("TIKTOK", items);
    return c.json({ status: "ok", ...result });
  });

  // --- YouTube ---
  router.get("/youtube/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const row = await c.env.LINK_DB
      .prepare("SELECT id, config, created_at FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string; created_at: string }>();
    if (!row) return c.json({ connected: false });

    const config = JSON.parse(row.config) as { email?: string; channel_title?: string; sync_status?: string };

    // 订阅数的真相现在是 per-tenant D1 的 user 表（is_follow = 1 的 YOUTUBE 行），不再是
    // config 里的旧快照。租户还没 provision 数据库时返 0 而不是报错 —— 这个接口是页面
    // 加载就调的，未 provision 是正常状态，不是错误状态（不同于 /tiktok/sync 等写路径）。
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    let subscriptionCount = 0;
    if (tenantDb) {
      try {
        const rows = await tenantDb.query<{ c: number }>(
          "SELECT COUNT(*) AS c FROM user WHERE channel_id = ? AND channel_type = 'YOUTUBE' AND is_follow = 1",
          [row.id]
        );
        subscriptionCount = Number(rows[0]?.c ?? 0);
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_status_count_error", channel_id: row.id, error: String(e) }));
      }
    }

    return c.json({
      connected: true,
      email: config.email,
      channel_title: config.channel_title,
      sync_status: config.sync_status,
      subscription_count: subscriptionCount,
      created_at: row.created_at,
    });
  });

  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string }>();
    if (!accountRow) return c.json({ connected: false, accountChannelId: null, subscriptions: [] });

    const config = JSON.parse(accountRow.config) as { email?: string };

    // 实时拉取，不吃 config 里的旧快照 —— 新订阅的频道要立刻出现在 flow 的选择器里
    // （与 YouTube Condition 节点已定的「取实时 API 数据、不吃快照」同一原则）。
    // 失败时返回空列表而不是 5xx：前端已有「No subscriptions found」空态，一次配额
    // 波动不该让整个 Inspector 报错。
    let subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] = [];
    let quotaCalls = 0;
    try {
      const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
      const accessToken = await tokenService.getValidToken(accountRow.id);
      const result = await fetchAllSubscriptions(accessToken);
      subscriptions = result.subscriptions;
      quotaCalls = result.calls;
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_subscriptions_fetch_error", channel_id: accountRow.id, error: String(e) }));
    }

    // 这是一条 UI 触发的**实时**读取（每打开一次 Inspector 就 ceil(订阅数/50) units），
    // 不记账会让 8000 units 的阈值告警系统性少算这部分量。整轮合并成一次记账：配额计数器
    // 是单个 KV key 的读-改-写，同一个 key 每秒只允许写一次。
    // 失败路径（fetchAllSubscriptions 抛出）会漏记已发出的那几次请求 —— 量级 ≤ 本次打开的
    // 页数，且只在出错时发生；为它改掉「抛异常」的契约不划算。记账失败也绝不能影响响应。
    if (quotaCalls > 0) {
      try {
        await recordYouTubeQuota(c.env, quotaCalls);
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_quota_record_failed", channel_id: accountRow.id, units: quotaCalls, error: String(e) }));
      }
    }

    return c.json({
      connected: true,
      accountChannelId: accountRow.id,
      email: config.email,
      subscriptions,
    });
  });

  router.get("/youtube/playlists", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string }>();
    if (!accountRow) return c.json({ connected: false, playlists: [] });

    const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
    let accessToken: string;
    try {
      accessToken = await tokenService.getValidToken(accountRow.id);
    } catch {
      // Account connected before offline access → no refresh token to list with. The user
      // must reconnect to use write actions anyway.
      return c.json({ connected: true, needsReconnect: true, playlists: [] });
    }

    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return c.json({ connected: true, playlists: [] });
    const data = (await res.json()) as { items?: { id: string; snippet?: { title?: string } }[] };
    return c.json({
      connected: true,
      playlists: (data.items || []).map((i) => ({ id: i.id, title: i.snippet?.title || i.id })),
    });
  });

  // --- Notion ---
  router.get("/notion/auth", async (c) => {
    const params = new URLSearchParams({
      client_id: c.env.NOTION_CLIENT_ID,
      redirect_uri: c.env.NOTION_REDIRECT_URI,
      response_type: "code",
      owner: "user",
      state: c.req.header("Cookie")?.match(/session=([^;]*)/)?.[1] ?? "",
    });
    return c.json({ url: `https://api.notion.com/v1/oauth/authorize?${params}` });
  });

  router.get("/notion/status", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'NOTION' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ connected: false });
    const config = JSON.parse(ch.config) as { channel_name?: string };
    return c.json({ connected: true, channel_name: config.channel_name });
  });

  router.get("/notion/folders", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'NOTION' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ error: "Notion not connected" }, 401);
    const config = JSON.parse(ch.config) as { access_token: string };
    const folders = await NotionChannel.listFolders(config.access_token);
    return c.json({ folders });
  });

  router.get("/notion/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const data = await c.env.KV.get(`session:${state}`);
    if (!data) return c.json({ error: "Invalid session" }, 401);
    const session = JSON.parse(data) as { member_id: string; tenant_id: number };

    const credentials = btoa(`${c.env.NOTION_CLIENT_ID}:${c.env.NOTION_CLIENT_SECRET}`);
    const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: c.env.NOTION_REDIRECT_URI }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return c.json({ error: `Notion token exchange failed: ${err}` }, 500);
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; workspace_id?: string; workspace_name?: string };

    const configJson = JSON.stringify({
      access_token: tokenData.access_token,
      channel_name: tokenData.workspace_name ?? null,
    });
    const sourceId = tokenData.workspace_id || crypto.randomUUID();

    await c.env.LINK_DB.prepare(
      `INSERT INTO channels (id, channel_type, config, source_channel_id, member_id, tenant_id, created_at, updated_at)
       VALUES (?, 'NOTION', ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`
    ).bind(crypto.randomUUID(), configJson, sourceId, session.member_id, session.tenant_id).run();

    return c.redirect("/content?notion=connected");
  });

  router.post("/notion/sync", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const tenantId = c.get("tenantId" as never) as number;
    // Per-tenant D1 — the source of truth. See /tiktok/sync's identical guard comment above.
    // Checked before the Notion fetch below, not just before the D1 write.
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'NOTION' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ error: "Notion not connected" }, 401);
    const notionConfig = JSON.parse(ch.config) as { access_token: string };

    const configRow = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'NOTION' AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!configRow) return c.json({ error: "No folders selected" }, 400);

    const folderConfig = JSON.parse(configRow.config) as { folder_ids?: string[]; access_token?: string };
    const channel = new NotionChannel(notionConfig.access_token);
    const items = await channel.fetchItems(folderConfig);

    const service = new ContentService(tenantDb, c.env.VECTORIZE, c.env.AI, tenantId, c.env.PIPELINE_CONTENT);
    const result = await service.syncBatch("NOTION", items);
    return c.json(result);
  });

  // --- Generic simple OAuth channel (single-connection, connect/disconnect only) ---
  // Used by any channel that just needs: is it connected? what's the display name? disconnect.
  // Channel-specific OAuth connect/callback still live under /api/auth/:type/*.
  router.get("/:type/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.param("type").toUpperCase();
    const displayField = c.req.query("field") || "display_name";
    const row = await c.env.LINK_DB
      .prepare("SELECT id, config, created_at FROM channels WHERE tenant_id = ? AND channel_type = ? AND is_active = 1 LIMIT 1")
      .bind(tenantId, channelType)
      .first<{ id: string; config: string; created_at: string }>();
    if (!row) return c.json({ connected: false });
    const config = JSON.parse(row.config) as Record<string, unknown>;
    return c.json({
      connected: true,
      displayName: config[displayField] as string | undefined,
      channel_id: row.id,
      created_at: row.created_at,
    });
  });

  router.delete("/:type", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.param("type").toUpperCase();
    await c.env.LINK_DB
      .prepare("UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE tenant_id = ? AND channel_type = ? AND is_active = 1")
      .bind(tenantId, channelType)
      .run();
    return c.json({ ok: true });
  });

  router.get("/:type/config", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.param("type").toUpperCase();
    const row = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = ? AND is_active = 1")
      .bind(tenantId, channelType)
      .first<{ config: string }>();
    return c.json({ config: row ? JSON.parse(row.config) : null });
  });

  router.put("/:type/config", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.param("type").toUpperCase();
    const { config } = await c.req.json<{ config: Record<string, unknown> }>();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await c.env.LINK_DB
      .prepare(
        `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
      )
      .bind(id, channelType, JSON.stringify(config), `${channelType}-${tenantId}`, tenantId, memberId, now, now)
      .run();

    if (channelType === "NOTION") {
      const ch = await c.env.LINK_DB
        .prepare("SELECT config FROM channels WHERE channel_type = 'NOTION' AND member_id = ? AND is_active = 1")
        .bind(memberId).first<{ config: string }>();
      if (ch && (config as { folder_ids?: string[] }).folder_ids) {
        // Per-tenant D1 — the source of truth. Scoped to this branch (not the whole route,
        // which is a generic per-channel-type config setter most types don't need D1 for),
        // checked before the Notion fetch below. See /tiktok/sync's identical guard comment.
        const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
        if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

        const notionConfig = JSON.parse(ch.config) as { access_token: string };
        const channel = new NotionChannel(notionConfig.access_token);
        const items = await channel.fetchItems(config);
        const service = new ContentService(tenantDb, c.env.VECTORIZE, c.env.AI, tenantId, c.env.PIPELINE_CONTENT);
        const result = await service.syncBatch("NOTION", items);
        return c.json({ ok: true, sync: result });
      }
    }

    return c.json({ ok: true });
  });

  // --- Shopify ---
  router.get("/shopify/auth", async (c) => {
    const shop = c.req.query("shop");
    if (!shop) return c.json({ error: "Missing shop parameter" }, 400);
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]*)/)?.[1] ?? "";
    const url = buildShopifyAuthUrl(shop, c.env.SHOPIFY_CLIENT_ID, c.env.SHOPIFY_REDIRECT_URI, sessionId);
    return c.json({ url });
  });

  router.get("/shopify/status", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'SHOPIFY' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ connected: false });
    const config = JSON.parse(ch.config) as { channel_name?: string };
    return c.json({ connected: true, channel_name: config.channel_name });
  });

  router.get("/shopify/products", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const ch = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'SHOPIFY' AND member_id = ? AND is_active = 1")
      .bind(memberId).first<{ config: string }>();
    if (!ch) return c.json({ error: "Shopify not connected" }, 401);
    const config = JSON.parse(ch.config) as { access_token: string; channel_name: string };
    if (!config.channel_name) return c.json({ error: "Shopify not connected" }, 401);
    const products = await fetchShopifyProducts(config.channel_name, config.access_token);
    return c.json({ products });
  });

  router.get("/shopify/callback", async (c) => {
    const code = c.req.query("code");
    const shop = c.req.query("shop");
    const state = c.req.query("state");
    if (!code || !shop || !state) return c.json({ error: "Missing code, shop, or state" }, 400);

    const data = await c.env.KV.get(`session:${state}`);
    if (!data) return c.json({ error: "Invalid session" }, 401);
    const session = JSON.parse(data) as { member_id: string; tenant_id: number };

    const tokenData = await exchangeShopifyCode(shop, c.env.SHOPIFY_CLIENT_ID, c.env.SHOPIFY_CLIENT_SECRET, code);

    const configJson = JSON.stringify({
      access_token: tokenData.access_token,
      channel_name: shop,
    });

    await c.env.LINK_DB.prepare(
      `INSERT INTO channels (id, channel_type, config, source_channel_id, member_id, tenant_id, created_at, updated_at)
       VALUES (?, 'SHOPIFY', ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(channel_type, source_channel_id) DO UPDATE SET config = excluded.config, member_id = excluded.member_id, is_active = 1, updated_at = datetime('now')`
    ).bind(crypto.randomUUID(), configJson, shop, session.member_id, session.tenant_id).run();

    return c.redirect("/commerce?shopify=connected");
  });

  return router;
}
