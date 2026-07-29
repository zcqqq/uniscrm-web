import { Hono } from "hono";
import type { Env } from "./types";
import { XWebhookService } from "./services/x-webhook";
import { UsersService, EVENT_VALUE_COLUMNS, type XUserData } from "./services/users";
import { EntityStateStore } from "./services/entity-state";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "./services/content";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";
import { EventMetadata_X } from "../../metadata/x";
import { ContentMetadata_X } from "../../metadata/x-byok";
import { resolveProps, consumedPaths } from "./services/pollers/resolve-props";

const POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;

// propIds an event's eventProps mapping can supply — same "mapped-but-columnless" guard as
// users.ts's MAPPED_USER_PROP_IDS, applied to the event pipeline: a metadata eventProps
// entry having a dataId doesn't mean EVENT_VALUE_COLUMNS has a matching R2 column for it.
const EVENT_ALLOWED_PROP_IDS = new Set(EVENT_VALUE_COLUMNS);

// The dataId paths an event's own metadata entry actually consumes from its scoped payload
// object — same relative-path computation resolveEventProps uses for the values themselves,
// reused here so raw_data can be stripped of exactly what eventProps already carries instead
// of storing the entire external payload (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量
// 数据不要存在数据库中」). Returns [] for an eventType with no EventMetadata_X entry.
function resolveEventConsumedPaths(eventType: string): string[] {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  if (!meta) return [];
  return consumedPaths(meta.eventProps, meta.linkPrefix, EVENT_ALLOWED_PROP_IDS);
}

// The event's metadata-declared eventProps, pulled out of the raw webhook payload for
// the R2 event pipeline. `scoped` is the linkPrefix-resolved user object (target.data /
// source.data / users.{...}.data) that every `{linkPrefix}.`-prefixed dataId is relative
// to — the counts live under `public_metrics` there, never at the top level.
//
// Gap: dm.received's `message_text` declares an unprefixed dataId with `[]` array syntax
// (`direct_message_events[].message_create.message_data.text`) which navigatePath cannot
// walk, so resolveProps silently drops it. The dm branch below supplies it explicitly.
function resolveEventProps(eventType: string, scoped?: Record<string, unknown> | null): Record<string, unknown> {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  if (!meta || !scoped) return {};
  return resolveProps(scoped, meta.eventProps, meta.linkPrefix);
}

// dm.received carries the message body in a shape no dataId resolver can reach; both the
// flow queue payload and the event pipeline record need it.
function extractDmText(payload: Record<string, unknown>): string | undefined {
  const events = payload.direct_message_events as Array<Record<string, unknown>> | undefined;
  const msgData = (events?.[0]?.message_create as Record<string, unknown> | undefined)?.message_data as Record<string, unknown> | undefined;
  return typeof msgData?.text === "string" ? msgData.text : undefined;
}

// like.create covers BOTH directions in one X event type, and its payload carries no "who
// liked it" field at all — only the liked Post and that Post's author. The counterparty is
// only ever in the event's `includes.users[]`. Prefer the `direction` X echoes back from the
// subscription's filter; a subscription created before metadata declared direction echoes
// nothing, so fall back to "was the liked Post mine".
function isInboundLike(payload: Record<string, unknown>, filterUserId: string, direction?: string): boolean {
  if (direction === "inbound") return true;
  if (direction === "outbound") return false;
  return typeof payload.liked_tweet_author_id === "string" && payload.liked_tweet_author_id === filterUserId;
}

// The other party in the event's includes — for an inbound like, the person who liked.
function findCounterparty(includes: Record<string, unknown> | undefined, filterUserId: string): Record<string, unknown> | null {
  const users = includes?.users as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(users)) return null;
  return users.find((u) => typeof u?.id === "string" && u.id !== filterUserId) || null;
}

function flattenUserPayload(userData?: Record<string, unknown>): Record<string, unknown> {
  if (!userData) return {};
  const pm = userData.public_metrics as Record<string, unknown> | undefined;
  return {
    name: String(userData.name || ""),
    username: String(userData.username || ""),
    verified_type: String(userData.verified_type || (userData.verified ? "blue" : "none")),
    followers_count: Number(pm?.followers_count || 0),
    following_count: Number(pm?.following_count || 0),
    // propId is post_count; tweet_count is X's name for the same field. Flow evaluates
    // conditions by propId, so emitting X's name here made "Posts" conditions never match.
    post_count: Number(pm?.tweet_count || 0),
    listed_count: Number(pm?.listed_count || 0),
    like_count: Number(pm?.like_count || 0),
    media_count: Number(pm?.media_count || 0),
  };
}

export function navigatePath(obj: unknown, path: string): unknown {
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

  if (!channel.tenant_id) {
    console.log(JSON.stringify({ event: "xaa_byok_no_tenant", channelId }));
    return;
  }

  // Per-tenant D1 — the source of truth (2026-07-26 plan). Skip before any write/side effect
  // (this webhook makes no outbound API calls of its own, but does write D1/R2/flow queue) if
  // the tenant has no provisioned database — dev has several e2e test tenants in this state.
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(channel.tenant_id)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) {
    console.log(JSON.stringify({ event: "xaa_byok_no_tenant_db", channelId }));
    return;
  }

  const data = (body["data"] || body) as {
    event_type?: string;
    filter?: { user_id?: string; direction?: string };
    payload?: Record<string, unknown>;
    includes?: Record<string, unknown>;
  };
  const eventType = data.event_type;
  const filterUserId = data.filter?.user_id;
  const payload = data.payload || {};

  if (!eventType) return;

  const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
  const entityState = new EntityStateStore(env.LINK_DB, channel.tenant_id);
  const usersService = new UsersService(tenantDb, {
    pipelineEvent: env.PIPELINE_EVENT,
    pipelineUser: env.PIPELINE_USER,
    tenantId: channel.tenant_id,
    entityState,
  });

  // Reuse the same event processing logic
  const fakeChannelInfo: ChannelInfo = { channelId, tenantId: channel.tenant_id, d1DatabaseId: tenant.d1_database_id };
  await processXEvent(eventType, filterUserId || "", payload, fakeChannelInfo, usersService, env, {
    includes: data.includes,
    direction: data.filter?.direction,
  });
}

async function processXEvent(
  eventType: string,
  filterUserId: string,
  payload: Record<string, unknown>,
  channelInfo: ChannelInfo,
  usersService: UsersService,
  env: Env,
  activity: { includes?: Record<string, unknown>; direction?: string } = {},
): Promise<void> {
  const { channelId, tenantId } = channelInfo;

  if (eventType === "follow.follow" || eventType === "follow.unfollow") {
    const source = payload.source as { data?: Record<string, unknown> } | undefined;
    const target = payload.target as { data?: Record<string, unknown> } | undefined;
    const sourceId = source?.data?.id as string | undefined;
    const targetId = target?.data?.id as string | undefined;

    if (sourceId === filterUserId && target?.data) {
      const userData = target.data;
      const isFollow = eventType === "follow.follow";
      const resolvedEventType = isFollow ? "follow.follow" : "follow.unfollow";
      // follow 状态与用户快照一次性写完:R2 读路径按 QUALIFY 取整行最新,
      // 分两次写会让后一次把前一次的列冲成 null。
      await usersService.upsertXWebhookUser(userData as XUserData, channelId, "X", { is_follow: isFollow ? 1 : 0 });
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
        eventProps: resolveEventProps(resolvedEventType, userData),
        consumedPaths: resolveEventConsumedPaths(resolvedEventType),
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
      const isFollow = eventType === "follow.follow";
      const resolvedEventType = isFollow ? "follow.followed" : "follow.unfollowed";
      // follow 状态与用户快照一次性写完:R2 读路径按 QUALIFY 取整行最新,
      // 分两次写会让后一次把前一次的列冲成 null。
      await usersService.upsertXWebhookUser(userData as XUserData, channelId, "X", { is_followed: isFollow ? 1 : 0 });
      await usersService.insertEvents([{
        userId: userData.id as string,
        channelId,
        eventType: resolvedEventType,
        eventTime: new Date().toISOString(),
        rawData: userData,
        eventProps: resolveEventProps(resolvedEventType, userData),
        consumedPaths: resolveEventConsumedPaths(resolvedEventType),
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

  // Inbound like — someone liked one of the Account's Posts. The event belongs to THAT person,
  // not to the Account: recording it under filterUserId (what the generic tail below does) would
  // read as "the Account liked something", which is the opposite of what happened. Outbound
  // likes can still arrive from a subscription created before metadata declared
  // direction:"inbound" — there includes.users[] holds the liked Post's AUTHOR, not a liker, so
  // nothing about it is safe to attribute and it falls through to the unchanged old behavior.
  if (eventType === "like.create" && isInboundLike(payload, filterUserId, activity.direction)) {
    const liker = findCounterparty(activity.includes, filterUserId);
    if (liker?.id) {
      await usersService.upsertXWebhookUser(liker as XUserData, channelId, "X");
      await usersService.insertEvents([{
        userId: liker.id as string,
        channelId,
        eventType,
        eventTime: new Date().toISOString(),
        // raw_data keeps the like object (which Post was liked); the liker's own fields already
        // landed in user_id and the event's metric columns, so consumedPaths strips nothing
        // from it in practice — it is passed for the same reason every other branch passes it.
        rawData: payload,
        eventProps: resolveEventProps(eventType, liker),
        consumedPaths: resolveEventConsumedPaths(eventType),
      }]);
      console.log(JSON.stringify({ event: "xaa_inbound_like_processed", channelId, userId: liker.id }));
      return;
    }
    console.log(JSON.stringify({ event: "xaa_inbound_like_no_liker_in_includes", channelId }));
  }

  if (eventType === "dm.read" || eventType === "dm.received") {
    const linkPrefix = eventType === "dm.read"
      ? "users.{direct_message_events[].initiating_user_id}.data"
      : "users.{direct_message_events[].message_create.sender_id}.data";
    const userData = resolveLinkPrefix(payload, linkPrefix);

    if (userData) {
      const userId = userData.id as string;
      if (userId && userId !== filterUserId) {
        await usersService.upsertXWebhookUser({
          id: userId,
          name: userData.name as string | undefined,
          username: userData.username as string | undefined,
          profile_image_url: userData.profile_image_url as string | undefined,
        }, channelId, "X");

        const flatPayload = flattenUserPayload(userData);
        if (eventType === "dm.received") {
          const text = extractDmText(payload);
          if (text) flatPayload.message_text = text;
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
      await usersService.upsertXWebhookUser({
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

  const eventMeta = EventMetadata_X.find((e) => e.eventType === eventType);
  const scopedUser = eventMeta?.linkPrefix ? resolveLinkPrefix(payload, eventMeta.linkPrefix) : payload;
  const eventProps = resolveEventProps(eventType, scopedUser);
  if (eventType === "dm.received") {
    const text = extractDmText(payload);
    if (text) eventProps.message_text = text;
  }

  await usersService.insertEvents([{
    userId: eventUserId,
    channelId,
    eventType,
    eventTime: new Date().toISOString(),
    rawData: payload,
    eventProps,
    consumedPaths: resolveEventConsumedPaths(eventType),
  }]);

  console.log(JSON.stringify({ event: "xaa_event_processed", eventType, userId: eventUserId }));
}

async function handleXActivityEvent(body: Record<string, unknown>, env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "xaa_webhook_received", body }));

  const data = (body["data"] || body) as {
    event_type?: string;
    filter?: { user_id?: string; direction?: string };
    payload?: Record<string, unknown>;
    includes?: Record<string, unknown>;
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

  if (!tenantId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_tenant", filterUserId }));
    return;
  }

  // Per-tenant D1 — the source of truth (2026-07-26 plan). Skip before any write/side effect
  // if the tenant has no provisioned database — dev has several e2e test tenants in this state.
  if (!d1DatabaseId) {
    console.log(JSON.stringify({ event: "xaa_webhook_no_tenant_db", filterUserId, tenantId }));
    return;
  }

  const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, d1DatabaseId);
  const entityState = new EntityStateStore(env.LINK_DB, tenantId);
  const usersService = new UsersService(tenantDb, {
    pipelineEvent: env.PIPELINE_EVENT,
    pipelineUser: env.PIPELINE_USER,
    tenantId,
    entityState,
  });

  // Handle content events (post.create/delete) — own posts, same own:get-posts metadata entry
  // x-posts.ts's poller uses (flowType "content" — see the spec's flowType table).
  if (eventType === "post.create") {
    const tweetId = payload.id as string;
    if (tweetId) {
      const props = resolveProps(payload, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
      if (payload.article) props.content_type = "ARTICLE";
      props.content_url = `https://x.com/i/status/${tweetId}`;
      const paths = consumedPaths(POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix, CONTENT_MAPPED_PROP_IDS);
      const contentService = new ContentService(tenantDb, env.VECTORIZE, env.AI, tenantId, env.PIPELINE_CONTENT);
      // Never let a throw here 500 the webhook — X retries a non-2xx delivery indefinitely and
      // eventually disables the subscription entirely over what may be a transient D1 REST
      // failure. Event recording (processXEvent, below) must still run regardless. Mirrors
      // post.delete's try/catch below.
      try {
        // flowType comes from the own:get-posts metadata entry itself, never a literal.
        await contentService.upsertContentFromMetadata(payload, props, channelId, "X", false, undefined, paths, POSTS_METADATA.flowType);
      } catch (e) {
        console.error(JSON.stringify({ event: "xaa_post_create_error", channelId, tweetId, error: String(e) }));
      }
    }
  }

  if (eventType === "post.delete") {
    const tweetId = payload.id as string || payload.tweet_id as string;
    if (tweetId) {
      const contentService = new ContentService(tenantDb, env.VECTORIZE, env.AI, tenantId, env.PIPELINE_CONTENT);
      // D1 is the truth now: look the row up directly by its business key (mirrors the
      // partial unique index own posts use — channel_id + source_content_id, list_id NULL)
      // instead of asking entity_state, which no longer tracks content identity at all
      // (task 5). Never let a throw here 500 the webhook — X retries the same delivery
      // indefinitely on a non-2xx response, and a delete is not worth an infinite retry loop.
      try {
        const rows = await tenantDb.query<{ id: string }>(
          "SELECT id FROM content WHERE channel_id = ? AND channel_type = 'X' AND source_content_id = ? AND list_id IS NULL",
          [channelId, tweetId]
        );
        if (rows.length > 0) {
          await contentService.delete(rows[0].id);
        } else {
          // Not in D1 — a historical R2-as-truth-era row, or a race with the write that
          // created it. deleteByKnownIdentity is kept for exactly this: it writes a tombstone
          // straight from what this handler already knows, no D1 row required.
          console.log(JSON.stringify({ event: "xaa_post_delete_not_found_in_d1", channelId, tweetId }));
          await contentService.deleteByKnownIdentity(crypto.randomUUID(), channelId, "X", tweetId);
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "xaa_post_delete_error", channelId, tweetId, error: String(e) }));
        await contentService.deleteByKnownIdentity(crypto.randomUUID(), channelId, "X", tweetId);
      }
    }
  }

  await processXEvent(eventType, filterUserId, payload, channelInfo, usersService, env, {
    includes: data.includes,
    direction: data.filter?.direction,
  });
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
      // tenant-scope-ok: external X webhook CRC challenge, authed by provider signature not a tenant session
      .prepare("SELECT config FROM channels WHERE id = ? AND is_active = 1")
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
