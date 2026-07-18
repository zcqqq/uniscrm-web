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
import { fetchOwnedLists } from "./services/x-posts-api";
import { resolveYouTubeChannelId, fetchChannelSnippet } from "./services/youtube-api";
import { findOrCreateWatchedChannel } from "./services/youtube-account";

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
    const [row, byokRow] = await Promise.all([
      c.env.LINK_DB
        .prepare("SELECT id, config, created_at FROM channels WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1 AND (is_byok = 0 OR is_byok IS NULL) LIMIT 1")
        .first<{ id: string; config: string; created_at: string }>(),
      c.env.LINK_DB
        .prepare("SELECT id FROM channels WHERE channel_type = 'X' AND is_active = 1 AND is_byok = 1 LIMIT 1")
        .first<{ id: string }>(),
    ]);
    const hasByok = !!byokRow;
    if (!row) return c.json({ connected: false, has_byok: hasByok });
    const config = JSON.parse(row.config) as { x_username?: string };
    return c.json({ connected: true, username: config.x_username, channel_id: row.id, created_at: row.created_at, has_byok: hasByok });
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

  router.delete("/x", async (c) => {
    await c.env.LINK_DB
      .prepare("UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1")
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
    const { channel_id, client_id, client_secret, consumer_secret } = await c.req.json<{
      channel_id?: string; client_id: string; client_secret: string; consumer_secret: string;
    }>();

    if (!client_id || !client_secret || !consumer_secret) {
      return c.json({ error: "Missing credentials" }, 400);
    }

    const masterKey = await c.env.ENCRYPTION_KEY.get();
    const [encClientId, encClientSecret, encConsumerSecret] = await Promise.all([
      encrypt(client_id, masterKey),
      encrypt(client_secret, masterKey),
      encrypt(consumer_secret, masterKey),
    ]);

    const url = new URL(c.req.url);
    const existing = channel_id
      ? await c.env.LINK_DB
          .prepare("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND channel_type = 'X' AND is_byok = 1")
          .bind(channel_id, tenantId)
          .first<{ config: string }>()
      : null;

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
      });
      await c.env.LINK_DB
        .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(updatedConfig, channel_id)
        .run();

      return c.json({
        channel_id,
        webhook_url: `${url.origin}/x/webhook/${channel_id}`,
        redirect_url: `${url.origin}/api/auth/x/callback`,
      });
    }

    if (channel_id) {
      // Not this tenant's channel — reject rather than falling through to
      // INSERT, which would either collide on the primary key or (if some
      // future change made the insert an upsert) silently overwrite someone
      // else's row.
      const claimedElsewhere = await c.env.LINK_DB
        .prepare("SELECT id FROM channels WHERE id = ?")
        .bind(channel_id)
        .first<{ id: string }>();
      if (claimedElsewhere) return c.json({ error: "Channel not found" }, 404);
    }

    const channelId = channel_id || crypto.randomUUID();
    const config = JSON.stringify({
      is_byok: true,
      app_client_id: encClientId,
      app_client_secret: encClientSecret,
      app_consumer_secret: encConsumerSecret,
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
      return {
        id: r.id,
        username: cfg.x_username || null,
        x_user_id: cfg.x_user_id || null,
        authorized: !!cfg.x_user_id,
        created_at: r.created_at,
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
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;

    const channel = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'TIKTOK' AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!channel) return c.json({ error: "TikTok channel not connected" }, 400);

    const config = JSON.parse(channel.config) as { access_token?: string };
    if (!config.access_token) return c.json({ error: "TikTok token missing" }, 400);

    const tiktok = new TikTokChannel(config.access_token);
    const items = await tiktok.fetchItems({});

    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    const result = await contentService.syncBatch("TIKTOK", items);
    return c.json({ status: "ok", ...result });
  });

  // --- YouTube ---
  router.post("/youtube/watch", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const { channelUrl } = await c.req.json<{ channelUrl: string }>();
    if (!channelUrl) return c.json({ error: "Missing channelUrl" }, 400);

    const resolved = await resolveYouTubeChannelId(c.env.YOUTUBE_API_KEY, channelUrl);
    if (!resolved) return c.json({ error: "Could not resolve this channel URL" }, 400);

    // resolveYouTubeChannelId's direct /channel/UC... path returns channelName/thumbnailUrl
    // as "" (no API call needed just to confirm the ID). Backfill display info with one more
    // Data API call here, since this is the layer that actually persists/returns it to the
    // client — an empty name would otherwise show up blank in the UI.
    let channelName = resolved.channelName;
    let thumbnailUrl = resolved.thumbnailUrl;
    if (!channelName) {
      const snippet = await fetchChannelSnippet(c.env.YOUTUBE_API_KEY, resolved.channelId);
      if (snippet) {
        channelName = snippet.channelName;
        thumbnailUrl = snippet.thumbnailUrl;
      }
    }

    const result = await findOrCreateWatchedChannel(c.env, tenantId, memberId, resolved.channelId, channelName, thumbnailUrl);
    return c.json(result);
  });

  router.get("/youtube/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const row = await c.env.LINK_DB
      .prepare("SELECT config, created_at FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string; created_at: string }>();
    if (!row) return c.json({ connected: false });

    const config = JSON.parse(row.config) as { email?: string; sync_status?: string; subscriptions?: unknown[] };
    return c.json({
      connected: true,
      email: config.email,
      sync_status: config.sync_status,
      subscription_count: (config.subscriptions || []).length,
      created_at: row.created_at,
    });
  });

  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!accountRow) return c.json({ subscriptions: [] });

    const accountConfig = JSON.parse(accountRow.config) as {
      subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
    };
    const subscriptions = accountConfig.subscriptions || [];

    const watchedRows = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .all<{ config: string }>();
    const watchedIds = new Set(
      watchedRows.results.map((r) => (JSON.parse(r.config) as { youtube_channel_id?: string }).youtube_channel_id)
    );

    return c.json({
      subscriptions: subscriptions.map((s) => ({ ...s, already_watching: watchedIds.has(s.channelId) })),
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
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;

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

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
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
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
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
        const notionConfig = JSON.parse(ch.config) as { access_token: string };
        const channel = new NotionChannel(notionConfig.access_token);
        const items = await channel.fetchItems(config);
        const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
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
