import { Hono } from "hono";
import type { Env } from "./types";
import { ContentService } from "./services/content";
import { EntityStateStore } from "./services/entity-state";
import type { TenantDataDB } from "../../shared/tenant-data-db";

type ChannelType = "LOCAL" | "NOTION" | "TIKTOK";
const VALID_CHANNELS: ChannelType[] = ["LOCAL", "NOTION", "TIKTOK"];

// Maps a ContentService throw to an HTTP response. `update`/`delete` throw exactly
// "ContentService.<method>: content <id> not found" for a missing row (see
// task-5-report.md's Method-by-method section) — that's the only genuine not-found shape.
// The match is anchored to the `ContentService.` prefix rather than a bare `.includes("not
// found")": TenantDataDB.query/run/batch (shared/tenant-data-db.ts) wrap ANY Cloudflare D1 API
// failure as "D1 query failed: <cloudflare message>" — a stale/deleted tenant D1 database (this
// class of incident has already happened twice, per project memory) could easily produce a
// message containing "not found" from Cloudflare's side, and a loose match would report that
// infrastructure failure to the client as "item doesn't exist", masking a real failure as a
// false absence. Neither case may collapse into a silent 200 —
// 数据准确性 > 系统稳定性 > 功能 > UI 界面.
const NOT_FOUND_RE = /^ContentService\.\w+: content .+ not found$/;

function errorResponse(err: unknown): { body: { error: string }; status: 404 | 500 } {
  const message = String(err);
  if (err instanceof Error && NOT_FOUND_RE.test(err.message)) {
    return { body: { error: message }, status: 404 };
  }
  return { body: { error: message }, status: 500 };
}

export function contentsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/items/sync", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    // Per-tenant D1 — the source of truth (2026-07-26 plan). authMiddleware only sets this when
    // tenants.d1_database_id is provisioned — absence means "not provisioned", not an error.
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

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

    const entityState = c.get("entityState" as never) as EntityStateStore;
    const service = new ContentService(
      tenantDb, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, entityState
    );
    try {
      const result = await service.syncBatch(channel_type as ChannelType, items);
      return c.json(result);
    } catch (err) {
      console.error(JSON.stringify({ event: "content_sync_failed", tenantId, error: String(err) }));
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  router.get("/items", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

    const channelType = c.req.query("channel_type") as ChannelType | undefined;
    if (channelType && !VALID_CHANNELS.includes(channelType)) {
      return c.json({ error: "Invalid channel_type" }, 400);
    }

    const entityState = c.get("entityState" as never) as EntityStateStore;
    const service = new ContentService(
      tenantDb, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, entityState
    );
    try {
      const items = await service.list(channelType);
      return c.json({ items });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_list_failed", tenantId, error: String(err) }));
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  router.patch("/items/:id", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

    const id = c.req.param("id");
    // `status` dropped from the accepted body: ContentService.update() no longer has a status
    // concept (see task-4-report.md — "plan removes the concept" entirely, no replacement).
    const fields = await c.req.json<{ title?: string; summary?: string }>();

    const entityState = c.get("entityState" as never) as EntityStateStore;
    const service = new ContentService(
      tenantDb, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, entityState
    );
    try {
      await service.update(id, fields);
      return c.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_update_failed", tenantId, id, error: String(err) }));
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  router.delete("/items/:id", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    if (!tenantDb) return c.json({ error: "Tenant DB not provisioned" }, 503);

    const id = c.req.param("id");

    const entityState = c.get("entityState" as never) as EntityStateStore;
    const service = new ContentService(
      tenantDb, c.env.VECTORIZE, c.env.AI, tenantId,
      c.env.PIPELINE_CONTENT, undefined, entityState
    );
    try {
      await service.delete(id);
      return c.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "content_delete_failed", tenantId, id, error: String(err) }));
      const { body, status } = errorResponse(err);
      return c.json(body, status);
    }
  });

  return router;
}
