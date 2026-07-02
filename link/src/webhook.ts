import { Hono } from "hono";
import type { Env } from "./types";
import { XWebhookService } from "./services/x-webhook";
import { XUsersService, type XUserData } from "./services/x-users";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";

function flattenUserPayload(userData?: Record<string, unknown>): Record<string, unknown> {
  if (!userData) return {};
  const pm = userData.public_metrics as Record<string, unknown> | undefined;
  return {
    name: String(userData.name || ""),
    username: String(userData.username || ""),
    verified_type: String(userData.verified_type || (userData.verified ? "blue" : "none")),
    followers_count: Number(pm?.followers_count || 0),
    following_count: Number(pm?.following_count || 0),
    tweet_count: Number(pm?.tweet_count || 0),
    listed_count: Number(pm?.listed_count || 0),
    like_count: Number(pm?.like_count || 0),
    media_count: Number(pm?.media_count || 0),
  };
}

function navigatePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveLinkPrefix(payload: Record<string, unknown>, linkPrefix: string): Record<string, unknown> | null {
  const dynamicMatch = linkPrefix.match(/^(.+?)\.\{(.+?)\}\.(.+)$/);
  if (!dynamicMatch) {
    return navigatePath(payload, linkPrefix) as Record<string, unknown> | null;
  }
  const [, outerPrefix, innerPath, suffix] = dynamicMatch;
  const arrayMatch = innerPath.match(/^(.+?)\[\]\.?(.*)$/);
  if (!arrayMatch) return null;
  const [, arrayKey, restPath] = arrayMatch;
  const arr = payload[arrayKey] as unknown[];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const firstElement = arr[0] as Record<string, unknown>;
  const dynamicValue = restPath ? navigatePath(firstElement, restPath) : firstElement;
  if (typeof dynamicValue !== "string") return null;
  const outerObj = outerPrefix === "" ? payload : navigatePath(payload, outerPrefix) as Record<string, unknown>;
  if (!outerObj || typeof outerObj !== "object") return null;
  const target = (outerObj as Record<string, unknown>)[dynamicValue] as Record<string, unknown>;
  if (!target) return null;
  return navigatePath(target, suffix) as Record<string, unknown> | null;
}

interface ChannelInfo {
  channelId: string;
  tenantId: number | null;
  d1DatabaseId: string | null;
}

async function findChannelByXUserId(linkDb: D1Database, mainDb: D1Database, xUserId: string): Promise<ChannelInfo | null> {
  const channel = await linkDb
    .prepare("SELECT id, tenant_id FROM channels WHERE channel_type IN ('TWITTER', 'X') AND source_channel_id = ? AND is_active = 1")
    .bind(xUserId)
    .first<{ id: string; tenant_id: number | null }>();
  if (!channel) return null;

  let d1DatabaseId: string | null = null;
  if (channel.tenant_id) {
    const tenant = await mainDb
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(channel.tenant_id)
      .first<{ d1_database_id: string | null }>();
    d1DatabaseId = tenant?.d1_database_id || null;
  }

  return { channelId: channel.id, tenantId: channel.tenant_id, d1DatabaseId };
}

async function handleXActivityEventByChannel(body: Record<string, unknown>, env: Env, channelId: string): Promise<void> {
  console.log(JSON.stringify({ event: "xaa_byok_webhook_received", channelId, body }));

  const channel = await env.LINK_DB
    .prepare("SELECT tenant_id FROM channels WHERE id = ? AND is_active = 1")
    .bind(channelId)
    .first<{ tenant_id: number | null }>();
  if (!channel) {
    console.log(JSON.stringify({ event: "xaa_byok_channel_not_found", channelId }));
    return;
  }

  let d1DatabaseId: string | null = null;
  if (channel.tenant_id) {
    const tenant = await env.WEB_DB
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(channel.tenant_id)
      .first<{ d1_database_id: string | null }>();
    d1DatabaseId = tenant?.d1_database_id || null;
  }
  if (!d1DatabaseId) {
    console.log(JSON.stringify({ event: "xaa_byok_no_tenant_db", channelId }));
    return;
  }

  const data = (body["data"] || body) as {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: Record<string, unknown>;
  };
  const eventType = data.event_type;
  const filterUserId = data.filter?.user_id;
  const payload = data.payload || {};

  if (!eventType) return;

  const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, d1DatabaseId);
  const usersService = new XUsersService(tenantDb, {
    queue: env.MAIGRET_QUEUE,
    pipelineEvent: env.PIPELINE_EVENT,
    pipelineUser: env.PIPELINE_USER,
    tenantId: channel.tenant_id ?? undefined,
  });

  // Reuse the same event processing logic
  const fakeChannelInfo: ChannelInfo = { channelId, tenantId: channel.tenant_id, d1DatabaseId };
  await processXEvent(eventType, filterUserId || "", payload, fakeChannelInfo, usersService, env);
}

async function processXEvent(
  eventType: string,
  filterUserId: string,
  payload: Record<string, unknown>,
  channelInfo: ChannelInfo,
  usersService: XUsersService,
  env: Env,
): Promise<void> {
  const { channelId, tenantId } = channelInfo;

  if (eventType === "follow.follow" || eventType === "follow.unfollow") {
    const source = payload.source as { data?: Record<string, unknown> } | undefined;
    const target = payload.target as { data?: Record<string, unknown> } | undefined;
    const sourceId = source?.data?.id as string | undefined;
    const targetId = target?.data?.id as string | undefined;

    if (sourceId === filterUserId && target?.data) {
      const userData = target.data;
      await usersService.upsertUser(userData as XUserData, channelId, "X");
      const isFollow = eventType === "follow.follow";
      const resolvedEventType = isFollow ? "follow.follow" : "follow.unfollow";
      await usersService.setFollowState(userData.id as string, channelId, "is_follow", isFollow ? 1 : 0);
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);

      if (tenantId) {
        await env.FLOW_QUEUE.send({
          tenantId,
          eventType: resolvedEventType,
          userId: userData.id as string,
          channelId,
          payload: flattenUserPayload(userData),
        });
      }
    } else if (targetId === filterUserId && source?.data) {
      const userData = source.data;
      await usersService.upsertUser(userData as XUserData, channelId, "X");
      const isFollow = eventType === "follow.follow";
      const resolvedEventType = isFollow ? "follow.followed" : "follow.unfollowed";
      await usersService.setFollowState(userData.id as string, channelId, "is_followed", isFollow ? 1 : 0);
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
      }]);

      if (tenantId) {
        await env.FLOW_QUEUE.send({
          tenantId,
          eventType: resolvedEventType,
          userId: userData.id as string,
          channelId,
          payload: flattenUserPayload(userData),
        });
      }
    }
    return;
  }

  if (eventType === "dm.read" || eventType === "dm.received") {
    const linkPrefix = eventType === "dm.read"
      ? "users.{direct_message_events[].initiating_user_id}.data"
      : "users.{direct_message_events[].message_create.sender_id}.data";
    const userData = resolveLinkPrefix(payload, linkPrefix);

    if (userData) {
      const userId = userData.id as string;
      if (userId && userId !== filterUserId) {
        await usersService.upsertUser({
          id: userId,
          name: userData.name as string | undefined,
          username: userData.username as string | undefined,
          profile_image_url: userData.profile_image_url as string | undefined,
        }, channelId, "X");

        const flatPayload = flattenUserPayload(userData);
        if (eventType === "dm.received") {
          const events = payload.direct_message_events as Array<Record<string, unknown>>;
          const msgData = (events?.[0]?.message_create as Record<string, unknown>)?.message_data as Record<string, unknown>;
          if (msgData?.text) flatPayload.message_text = msgData.text;
        }

        if (tenantId) {
          await env.FLOW_QUEUE.send({ tenantId, eventType, userId, channelId, payload: flatPayload });
        }
      }
    }
  }

  if (eventType.startsWith("chat.")) {
    const senderId = payload.sender_id as string | undefined
      || payload.user_id as string | undefined
      || payload.id as string | undefined;
    if (senderId && senderId !== filterUserId) {
      await usersService.upsertUser({
        id: senderId,
        username: payload.sender_username as string | undefined || payload.username as string | undefined,
        name: payload.sender_name as string | undefined || payload.name as string | undefined,
        profile_image_url: payload.sender_profile_image_url as string | undefined || payload.profile_image_url as string | undefined,
      }, channelId, "X");
    }
  }

  const eventUserId = (() => {
    if (eventType === "dm.read") {
      const events = payload.direct_message_events as Array<Record<string, unknown>> | undefined;
      return events?.[0]?.initiating_user_id as string || filterUserId;
    }
    if (eventType === "dm.received") {
      const events = payload.direct_message_events as Array<Record<string, unknown>> | undefined;
      const mc = events?.[0]?.message_create as Record<string, unknown> | undefined;
      return mc?.sender_id as string || filterUserId;
    }
    if (eventType.startsWith("chat.")) {
      return payload.sender_id as string || payload.user_id as string || filterUserId;
    }
    return filterUserId;
  })();

  await usersService.insertEvents([{
    userId: eventUserId,
    channelId,
    eventType,
    eventTime: new Date().toISOString(),
    rawData: payload,
  }]);

  console.log(JSON.stringify({ event: "xaa_event_processed", eventType, userId: eventUserId }));
}

async function handleXActivityEvent(body: Record<string, unknown>, env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "xaa_webhook_received", body }));

  const data = (body["data"] || body) as {
    event_type?: string;
    filter?: { user_id?: string };
    payload?: Record<string, unknown>;
    tag?: string;
  };

  const eventType = data.event_type;
  const filterUserId = data.filter?.user_id;
  const payload = data.payload || {};

  if (!eventType || !filterUserId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_match", eventType, filterUserId, keys: Object.keys(body) }));
    return;
  }

  const channelInfo = await findChannelByXUserId(env.LINK_DB, env.WEB_DB, filterUserId);
  if (!channelInfo) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_channel", filterUserId }));
    return;
  }
  const { channelId, tenantId, d1DatabaseId } = channelInfo;

  if (!d1DatabaseId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_tenant_db", filterUserId, tenantId }));
    return;
  }

  const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, d1DatabaseId);
  const usersService = new XUsersService(tenantDb, {
    queue: env.MAIGRET_QUEUE,
    pipelineEvent: env.PIPELINE_EVENT,
    pipelineUser: env.PIPELINE_USER,
    tenantId: tenantId ?? undefined,
  });

  // Handle content events (post.create/delete) which need tenantDb directly
  if (eventType === "post.create") {
    const tweetId = payload.id as string;
    const text = payload.text as string || "";
    if (tweetId) {
      const shareUrl = `https://x.com/i/web/status/${tweetId}`;
      await tenantDb.run(
        `INSERT INTO content (id, channel_type, source_content_id, title, summary, status, source_url, raw_data, created_at, updated_at)
         VALUES (?, 'X', ?, ?, NULL, 'new', ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(channel_type, source_content_id) DO UPDATE SET title = excluded.title, raw_data = excluded.raw_data, updated_at = datetime('now')`,
        [crypto.randomUUID(), tweetId, text.slice(0, 200), shareUrl, JSON.stringify(payload)]
      );
    }
  }

  if (eventType === "post.delete") {
    const tweetId = payload.id as string || payload.tweet_id as string;
    if (tweetId) {
      await tenantDb.run(
        `UPDATE content SET status = 'deleted', updated_at = datetime('now') WHERE channel_type = 'X' AND source_content_id = ?`,
        [tweetId]
      );
    }
  }

  await processXEvent(eventType, filterUserId, payload, channelInfo, usersService, env);
}

export function webhookRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/webhook", async (c) => {
    const crcToken = c.req.query("crc_token");
    if (!crcToken) return c.json({ error: "Missing crc_token" }, 400);
    const webhookService = new XWebhookService(c.env.X_CONSUMER_SECRET);
    const responseToken = await webhookService.computeCrcResponse(crcToken);
    return c.json({ response_token: responseToken });
  });

  router.post("/webhook", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      await handleXActivityEvent(body, c.env);
      return c.json({ ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ status: "error", message: msg }, 500);
    }
  });

  // BYOK per-channel webhook: CRC challenge
  router.get("/webhook/:channelId", async (c) => {
    const crcToken = c.req.query("crc_token");
    if (!crcToken) return c.json({ error: "Missing crc_token" }, 400);

    const channelId = c.req.param("channelId");
    const row = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE id = ? AND is_byok = 1 AND is_active = 1")
      .bind(channelId)
      .first<{ config: string }>();
    if (!row) return c.json({ error: "Channel not found" }, 404);

    const config = JSON.parse(row.config) as ByokConfig;
    const creds = await getAppCredentials(c.env, config);
    const webhookService = new XWebhookService(creds.consumerSecret);
    const responseToken = await webhookService.computeCrcResponse(crcToken);
    return c.json({ response_token: responseToken });
  });

  // BYOK per-channel webhook: event reception
  router.post("/webhook/:channelId", async (c) => {
    try {
      const channelId = c.req.param("channelId");
      const body = await c.req.json<Record<string, unknown>>();
      await handleXActivityEventByChannel(body, c.env, channelId);
      return c.json({ ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ status: "error", message: msg }, 500);
    }
  });

  return router;
}
