import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";
import { ContentService } from "./services/content";
import { LimitService } from "./services/limit";
import { NotionChannel } from "./channels/notion";
import { TikTokChannel } from "./channels/tiktok";
import {
  buildShopifyAuthUrl,
  exchangeShopifyCode,
  fetchShopifyProducts,
} from "./channels/shopify";
import { encrypt } from "./services/crypto";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";

export function channelsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // List channels by type
  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const type = (c.req.query("type") || "").toUpperCase();
    const rows = await c.env.LINK_DB.prepare(
      "SELECT id, config FROM channels WHERE tenant_id = ? AND channel_type IN (?, 'TWITTER') AND is_active = 1"
    ).bind(tenantId, type).all<{ id: string; config: string }>();
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

  router.delete("/x", async (c) => {
    await c.env.LINK_DB
      .prepare("UPDATE channels SET is_active = 0, updated_at = datetime('now') WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1")
      .run();
    return c.json({ ok: true });
  });

  // --- X BYOK ---
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

    const url = new URL(c.req.url);
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

    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    await limitService.enforceContentLimit(items.length);
    const result = await contentService.syncBatch("TIKTOK", items);
    return c.json({ status: "ok", ...result });
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
    const { confirmed } = await c.req.json<{ confirmed?: boolean }>().catch(() => ({ confirmed: undefined }));

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

    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const check = await limitService.checkContentLimit(items.length);
    if (!check.allowed && !confirmed) {
      return c.json({ needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
    }
    if (!check.allowed && confirmed) {
      await limitService.enforceContentLimit(check.overflow);
    }

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
        const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
        const check = await limitService.checkContentLimit(items.length);
        if (!check.allowed) {
          return c.json({ ok: true, needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
        }
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
