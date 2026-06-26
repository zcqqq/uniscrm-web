import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";
import { ContentService } from "./services/content";
import { LimitService } from "./services/limit";

type ChannelType = "LOCAL" | "NOTION" | "TIKTOK";
const VALID_CHANNELS: ChannelType[] = ["LOCAL", "NOTION", "TIKTOK"];

export function contentsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/items/sync", async (c) => {
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;
    const { channel_type, items, confirmed } = await c.req.json<{
      channel_type: string;
      items: {
        source_content_id: string;
        title: string;
        summary: string | null;
        source_url: string | null;
        source_updated_at: string | null;
        raw_data?: Record<string, unknown>;
      }[];
      confirmed?: boolean;
    }>();

    if (!VALID_CHANNELS.includes(channel_type as ChannelType)) {
      return c.json({ error: "Invalid channel_type" }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: "Items array is required" }, 400);
    }
    for (const item of items) {
      if (!item.source_content_id || !item.title) {
        return c.json({ error: "Each item must have source_content_id and title" }, 400);
      }
    }

    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const check = await limitService.checkContentLimit(items.length);
    if (!check.allowed && !confirmed) {
      return c.json({ needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
    }
    if (!check.allowed && confirmed) {
      await limitService.enforceContentLimit(check.overflow);
    }

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    const result = await service.syncBatch(channel_type as ChannelType, items);
    return c.json(result);
  });

  router.get("/items", async (c) => {
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.query("channel_type") as ChannelType | undefined;

    if (channelType && !VALID_CHANNELS.includes(channelType)) {
      return c.json({ error: "Invalid channel_type" }, 400);
    }

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    const items = await service.list(channelType);
    return c.json({ items });
  });

  router.patch("/items/:id", async (c) => {
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;
    const id = c.req.param("id");
    const fields = await c.req.json<{ title?: string; summary?: string; status?: string }>();

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    await service.update(id, fields);
    return c.json({ ok: true });
  });

  router.delete("/items/:id", async (c) => {
    const tenantDataDb = c.get("tenantDataDb" as never) as TenantDataDB;
    const tenantId = c.get("tenantId" as never) as number;
    const id = c.req.param("id");

    const service = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
    await service.delete(id);
    return c.json({ ok: true });
  });

  return router;
}
