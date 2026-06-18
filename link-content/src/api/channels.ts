import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, Session } from "../types";
import type { TenantDataDB } from "../../../shared/tenant-data-db";
import { OAuthService } from "../services/oauth";
import { ContentService } from "../services/content";
import { LimitService } from "../services/limit";
import { NotionChannel } from "../channels/notion";
import { TikTokChannel } from "../channels/tiktok";
import { TenantDataDB as TenantDataDBClass } from "../../../shared/tenant-data-db";

export function createChannelsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/notion/auth", async (c) => {
    const sessionId = getCookie(c, "session");
    const params = new URLSearchParams({
      client_id: c.env.NOTION_CLIENT_ID,
      redirect_uri: c.env.NOTION_REDIRECT_URI,
      response_type: "code",
      owner: "user",
      state: sessionId ?? "",
    });
    return c.json({ url: `https://api.notion.com/v1/oauth/authorize?${params}` });
  });

  router.get("/notion/status", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(memberId, "notion");

    if (!token) {
      return c.json({ connected: false });
    }
    return c.json({ connected: true, channel_name: token.channel_name });
  });

  router.get("/notion/folders", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(memberId, "notion");

    if (!token) {
      return c.json({ error: "Notion not connected" }, 401);
    }

    const folders = await NotionChannel.listFolders(token.access_token);
    return c.json({ folders });
  });

  router.post("/notion/sync", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;
    const { confirmed } = await c.req.json<{ confirmed?: boolean }>().catch(() => ({ confirmed: undefined }));
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(memberId, "notion");

    if (!token) {
      return c.json({ error: "Notion not connected" }, 401);
    }

    const configRow = await c.env.DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'NOTION'")
      .bind(tenantId)
      .first<{ config: string }>();

    if (!configRow) {
      return c.json({ error: "No folders selected" }, 400);
    }

    const config = JSON.parse(configRow.config) as { folder_ids: string[] };
    const channel = new NotionChannel(token.access_token);
    const items = await channel.fetchItems(config);

    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const check = await limitService.checkLimit(items.length);

    if (!check.allowed && !confirmed) {
      return c.json({
        needsConfirmation: true,
        overflow: check.overflow,
        wouldDelete: check.wouldDelete,
      });
    }

    if (!check.allowed && confirmed) {
      await limitService.enforceLimit(check.overflow);
    }

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    const result = await service.syncBatch("NOTION", items);
    return c.json(result);
  });

  router.get("/:type/config", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.param("type").toUpperCase();

    const row = await c.env.DB
      .prepare("SELECT config FROM channels WHERE tenant_id = ? AND channel_type = ?")
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

    await c.env.DB
      .prepare(
        `INSERT INTO channels (id, channel_type, config, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, channel_type) DO UPDATE SET
           config = excluded.config,
           updated_at = excluded.updated_at`
      )
      .bind(id, channelType, JSON.stringify(config), tenantId, now, now)
      .run();

    if (channelType === "NOTION") {
      const oauth = new OAuthService(c.env.DB);
      const token = await oauth.getToken(memberId, "notion");
      if (token && (config as { folder_ids?: string[] }).folder_ids) {
        const channel = new NotionChannel(token.access_token);
        const items = await channel.fetchItems(config);

        const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
        const check = await limitService.checkLimit(items.length);

        if (!check.allowed) {
          return c.json({
            ok: true,
            needsConfirmation: true,
            overflow: check.overflow,
            wouldDelete: check.wouldDelete,
          });
        }

        const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
        const result = await service.syncBatch("NOTION", items);
        return c.json({ ok: true, sync: result });
      }
    }

    return c.json({ ok: true });
  });

  return router;
}

export function createNotionCallbackRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/notion/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.json({ error: "Missing code or state" }, 400);
    }

    const data = await c.env.KV.get(`session:${state}`);
    const session = data ? (JSON.parse(data) as Session) : null;
    if (!session) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const credentials = btoa(`${c.env.NOTION_CLIENT_ID}:${c.env.NOTION_CLIENT_SECRET}`);
    const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: c.env.NOTION_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return c.json({ error: `Notion token exchange failed: ${err}` }, 500);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      workspace_name?: string;
    };

    const oauth = new OAuthService(c.env.DB);
    await oauth.saveToken(session.member_id, "notion", {
      access_token: tokenData.access_token,
      channel_name: tokenData.workspace_name ?? null,
    });

    return c.redirect("/content?notion=connected");
  });

  router.post("/tiktok/sync", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;

    const channel = await c.env.DB
      .prepare(`SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'TIKTOK'`)
      .bind(tenantId)
      .first<{ config: string }>();

    if (!channel) {
      return c.json({ error: "TikTok channel not connected" }, 400);
    }

    const config = JSON.parse(channel.config) as { access_token?: string };
    if (!config.access_token) {
      return c.json({ error: "TikTok token missing" }, 400);
    }

    const tiktok = new TikTokChannel(config.access_token);
    const items = await tiktok.fetchItems({});

    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    await limitService.enforceLimit(items.length);
    const result = await contentService.syncBatch("TIKTOK", items);

    return c.json({ status: "ok", ...result });
  });

  router.get("/tiktok/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const channel = await c.env.DB
      .prepare(`SELECT config FROM channels WHERE tenant_id = ? AND channel_type = 'TIKTOK'`)
      .bind(tenantId)
      .first<{ config: string }>();

    if (!channel) return c.json({ connected: false });
    const config = JSON.parse(channel.config) as { display_name?: string };
    return c.json({ connected: true, displayName: config.display_name });
  });

  return router;
}
