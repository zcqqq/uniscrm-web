import { Hono } from "hono";
import type { Env, ChannelType } from "../types";
import { ContentService } from "../services/content";
import { LimitService } from "../services/limit";

const VALID_CHANNELS: ChannelType[] = ["LOCAL", "NOTION"];

export function createContentsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/sync", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { channel_type, items, confirmed } = await c.req.json<{
      channel_type: string;
      items: {
        channel_source_id: string;
        title: string;
        summary: string | null;
        source_url: string | null;
        source_modified_at: string | null;
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
      if (!item.channel_source_id || !item.title) {
        return c.json({ error: "Each item must have channel_source_id and title" }, 400);
      }
    }

    const limitService = new LimitService(c.env.DB, c.env.VECTORIZE);
    const check = await limitService.checkLimit(userId, items.length);

    if (!check.allowed && !confirmed) {
      return c.json({
        needsConfirmation: true,
        overflow: check.overflow,
        wouldDelete: check.wouldDelete,
      });
    }

    if (!check.allowed && confirmed) {
      await limitService.enforceLimit(userId, check.overflow);
    }

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const result = await service.syncBatch(userId, channel_type as ChannelType, items);
    return c.json(result);
  });

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const channelType = c.req.query("channel_type") as ChannelType | undefined;

    if (channelType && !VALID_CHANNELS.includes(channelType)) {
      return c.json({ error: "Invalid channel_type" }, 400);
    }

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(userId, channelType);
    return c.json({ items });
  });

  router.patch("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");
    const fields = await c.req.json<{ title?: string; summary?: string; status?: string }>();

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.update(id, userId, fields);
    return c.json({ ok: true });
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, userId);
    return c.json({ ok: true });
  });

  return router;
}
