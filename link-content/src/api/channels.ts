import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { OAuthService } from "../services/oauth";
import { ContentService } from "../services/content";
import { NotionChannel } from "../channels/notion";

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
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "notion");

    if (!token) {
      return c.json({ connected: false });
    }
    return c.json({ connected: true, channel_name: token.channel_name });
  });

  router.get("/notion/folders", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "notion");

    if (!token) {
      return c.json({ error: "Notion not connected" }, 401);
    }

    const folders = await NotionChannel.listFolders(token.access_token);
    return c.json({ folders });
  });

  router.post("/notion/sync", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "notion");

    if (!token) {
      return c.json({ error: "Notion not connected" }, 401);
    }

    const configRow = await c.env.DB
      .prepare("SELECT config FROM channel_configs WHERE user_id = ? AND channel_type = 'NOTION'")
      .bind(userId)
      .first<{ config: string }>();

    if (!configRow) {
      return c.json({ error: "No folders selected" }, 400);
    }

    const config = JSON.parse(configRow.config) as { folder_ids: string[] };
    const channel = new NotionChannel(token.access_token);
    const items = await channel.fetchItems(config);

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const result = await service.syncBatch(userId, "NOTION", items);
    return c.json(result);
  });

  router.get("/:type/config", async (c) => {
    const userId = c.get("userId" as never) as string;
    const channelType = c.req.param("type").toUpperCase();

    const row = await c.env.DB
      .prepare("SELECT config FROM channel_configs WHERE user_id = ? AND channel_type = ?")
      .bind(userId, channelType)
      .first<{ config: string }>();

    return c.json({ config: row ? JSON.parse(row.config) : null });
  });

  router.put("/:type/config", async (c) => {
    const userId = c.get("userId" as never) as string;
    const channelType = c.req.param("type").toUpperCase();
    const { config } = await c.req.json<{ config: Record<string, unknown> }>();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await c.env.DB
      .prepare(
        `INSERT INTO channel_configs (id, user_id, channel_type, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, channel_type) DO UPDATE SET
           config = excluded.config,
           updated_at = excluded.updated_at`
      )
      .bind(id, userId, channelType, JSON.stringify(config), now, now)
      .run();

    if (channelType === "NOTION") {
      const oauth = new OAuthService(c.env.DB);
      const token = await oauth.getToken(userId, "notion");
      if (token && (config as { folder_ids?: string[] }).folder_ids) {
        const channel = new NotionChannel(token.access_token);
        const items = await channel.fetchItems(config);
        const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
        const result = await service.syncBatch(userId, "NOTION", items);
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
    const session = data ? (JSON.parse(data) as { user_id: string; email: string }) : null;
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
    await oauth.saveToken(session.user_id, "notion", {
      access_token: tokenData.access_token,
      channel_name: tokenData.workspace_name ?? null, // map Notion's field to our field
    });

    return c.redirect("/content?notion=connected");
  });

  return router;
}
