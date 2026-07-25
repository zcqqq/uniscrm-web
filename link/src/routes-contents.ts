import { Hono } from "hono";
import type { Env } from "./types";
import { ContentService } from "./services/content";
import { EntityStateStore } from "./services/entity-state";
import { R2SqlError } from "../../shared/r2-sql";

type ChannelType = "LOCAL" | "NOTION" | "TIKTOK";
const VALID_CHANNELS: ChannelType[] = ["LOCAL", "NOTION", "TIKTOK"];

export function contentsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/items/sync", async (c) => {
    const entityState = c.get("entityState" as never) as EntityStateStore;
    const tenantId = c.get("tenantId" as never) as number;
    const { channel_type, items } = await c.req.json<{
      channel_type: string;
      items: {
        source_content_id: string;
        title: string;
        summary: string | null;
        source_url: string | null;
        source_updated_at: string | null;
        raw_data?: Record<string, unknown>;
      }[];
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

    // syncBatch never reads R2 (it only claims entity_state + sends to the pipeline), so
    // r2Env being passed here is unused today — kept for construction-shape consistency with
    // the other three routes below, so a future syncBatch caller doesn't need a signature audit.
    const service = new ContentService(
      entityState, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, c.env
    );
    try {
      const result = await service.syncBatch(channel_type as ChannelType, items);
      return c.json(result);
    } catch (err) {
      // 数据准确性 > 系统稳定性 > 功能 > UI 界面 —— R2 失败绝不能伪装成"没有变化"。
      console.error(JSON.stringify({ event: "content_sync_failed", tenantId, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  router.get("/items", async (c) => {
    const entityState = c.get("entityState" as never) as EntityStateStore;
    const tenantId = c.get("tenantId" as never) as number;
    const channelType = c.req.query("channel_type") as ChannelType | undefined;

    if (channelType && !VALID_CHANNELS.includes(channelType)) {
      return c.json({ error: "Invalid channel_type" }, 400);
    }

    const service = new ContentService(
      entityState, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, c.env
    );
    try {
      const items = await service.list(channelType);
      return c.json({ items });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_list_failed", tenantId, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  router.patch("/items/:id", async (c) => {
    const entityState = c.get("entityState" as never) as EntityStateStore;
    const tenantId = c.get("tenantId" as never) as number;
    const id = c.req.param("id");
    // `status` dropped from the accepted body: ContentService.update() no longer has a status
    // concept (see task-4-report.md — "plan removes the concept" entirely, no replacement).
    const fields = await c.req.json<{ title?: string; summary?: string }>();

    const service = new ContentService(
      entityState, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, c.env
    );
    try {
      await service.update(id, fields);
      return c.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_update_failed", tenantId, id, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  router.delete("/items/:id", async (c) => {
    const entityState = c.get("entityState" as never) as EntityStateStore;
    const tenantId = c.get("tenantId" as never) as number;
    const id = c.req.param("id");

    const service = new ContentService(
      entityState, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, c.env
    );
    try {
      await service.delete(id);
      return c.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_delete_failed", tenantId, id, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  return router;
}
