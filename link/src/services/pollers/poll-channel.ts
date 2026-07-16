import type { Env, ChannelType } from "../../types";
import { getAppCredentials, type ByokConfig } from "../app-credentials";
import { XTokenService } from "../x-token";
import { TikTokTokenService } from "../tiktok-token";
import { XUnauthorizedError } from "../x-errors";
import { TikTokUnauthorizedError } from "../tiktok-errors";
import { runFollowersPoller } from "./x-followers";
import { runPostsPoller } from "./x-posts";
import { runTikTokContentPoller } from "./tiktok-content";
import { runListPostsPoller } from "./x-list-posts";
import { TenantDataDB } from "../../../../shared/tenant-data-db";

const PER_CHANNEL_BUDGET_MS = 20_000;
const REPOLL_INTERVAL_MS = 55 * 60 * 1000;

async function shouldPoll(env: Env, channelId: string, pollerName: string): Promise<boolean> {
  const state = await env.LINK_DB
    .prepare("SELECT backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(channelId, pollerName)
    .first<{ backfill_complete: number; last_polled_at: string | null }>();
  if (!state) {
    console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_no_state_row`, channel_id: channelId }));
    return false;
  }
  if (state.backfill_complete && state.last_polled_at) {
    const elapsedMs = Date.now() - new Date(state.last_polled_at).getTime();
    if (elapsedMs < REPOLL_INTERVAL_MS) {
      console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_too_recent`, channel_id: channelId, elapsedMs }));
      return false;
    }
  }
  return true;
}

async function resolveTenantDb(env: Env, tenantId: number): Promise<TenantDataDB | null> {
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return null;
  return new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
}

export async function pollChannelOnce(env: Env, channelType: ChannelType, channelId: string): Promise<void> {
  const row = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = ? AND id = ? AND is_active = 1")
    .bind(channelType, channelId)
    .first<{ id: string; config: string; tenant_id: number | null }>();
  if (!row) return;

  if (channelType === "X") {
    await pollXChannel(env, row);
  } else if (channelType === "TIKTOK") {
    await pollTikTokChannel(env, row);
  }
}

async function pollXChannel(env: Env, row: { id: string; config: string; tenant_id: number | null }): Promise<void> {
  const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
  if (!config.is_byok) return;
  if (!config.x_user_id || !row.tenant_id) return;

  const pollFollowers = await shouldPoll(env, row.id, "followers");
  const pollPosts = await shouldPoll(env, row.id, "posts");
  if (!pollFollowers && !pollPosts) return;

  let accessToken: string;
  let tenantDb: import("../../../../shared/tenant-data-db").TenantDataDB;
  let tokenService: XTokenService;
  try {
    const creds = await getAppCredentials(env, config);
    tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
    accessToken = await tokenService.getValidToken(row.id);

    const db = await resolveTenantDb(env, row.tenant_id!);
    if (!db) return;
    tenantDb = db;
  } catch (e) {
    console.error(JSON.stringify({ event: "poll_setup_error", channel_id: row.id, error: String(e) }));
    return;
  }

  if (pollFollowers) {
    try {
      try {
        await runFollowersPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          pipelineUser: env.PIPELINE_USER, deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      } catch (e) {
        if (!(e instanceof XUnauthorizedError)) throw e;
        accessToken = await tokenService.refreshAccessToken(row.id);
        await runFollowersPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          pipelineUser: env.PIPELINE_USER, deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "followers_poll_error", channel_id: row.id, error: String(e) }));
    }
  }

  if (pollPosts) {
    try {
      try {
        await runPostsPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
          deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      } catch (e) {
        if (!(e instanceof XUnauthorizedError)) throw e;
        accessToken = await tokenService.refreshAccessToken(row.id);
        await runPostsPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
          deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "posts_poll_error", channel_id: row.id, error: String(e) }));
    }
  }
}

async function pollTikTokChannel(env: Env, row: { id: string; config: string; tenant_id: number | null }): Promise<void> {
  if (!row.tenant_id) return;

  const pollContent = await shouldPoll(env, row.id, "content");
  if (!pollContent) return;

  let accessToken: string;
  let tenantDb: import("../../../../shared/tenant-data-db").TenantDataDB;
  const tokenService = new TikTokTokenService(env.LINK_DB, env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET);
  try {
    accessToken = await tokenService.getValidToken(row.id);
    const db = await resolveTenantDb(env, row.tenant_id);
    if (!db) return;
    tenantDb = db;
  } catch (e) {
    console.error(JSON.stringify({ event: "poll_setup_error", channel_id: row.id, error: String(e) }));
    return;
  }

  try {
    try {
      await runTikTokContentPoller({
        channelId: row.id, accessToken, linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    } catch (e) {
      if (!(e instanceof TikTokUnauthorizedError)) throw e;
      accessToken = await tokenService.refreshAccessToken(row.id);
      await runTikTokContentPoller({
        channelId: row.id, accessToken, linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "tiktok_content_poll_error", channel_id: row.id, error: String(e) }));
  }
}

export async function pollXListPosts(env: Env, channelId: string, listId: string): Promise<void> {
  const row = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = 'X' AND id = ? AND is_active = 1")
    .bind(channelId)
    .first<{ id: string; config: string; tenant_id: number | null }>();
  if (!row) return;

  const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
  if (!config.is_byok || !config.x_user_id || !row.tenant_id) return;

  const pollerName = `list_posts:${listId}`;

  // No "connect" moment seeds this row the way OAuth-connect does for the standard pollers —
  // a list watch first exists the moment a flow publishes an xContentTrigger List Posts node.
  // Without this, shouldPoll's "no state row -> skip" guard (below) would mean this list
  // never gets polled. Seed it before the shouldPoll check so the very first cron cycle that
  // sees this watch already has a row to gate against on the next cycle.
  await env.LINK_DB
    .prepare("INSERT OR IGNORE INTO channel_poll_state (channel_id, poller_name, backfill_complete) VALUES (?, ?, 0)")
    .bind(channelId, pollerName)
    .run();

  if (!(await shouldPoll(env, channelId, pollerName))) return;

  let accessToken: string;
  let tenantDb: import("../../../../shared/tenant-data-db").TenantDataDB;
  let tokenService: XTokenService;
  try {
    const creds = await getAppCredentials(env, config);
    tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
    accessToken = await tokenService.getValidToken(channelId);

    const db = await resolveTenantDb(env, row.tenant_id!);
    if (!db) return;
    tenantDb = db;
  } catch (e) {
    console.error(JSON.stringify({ event: "list_posts_poll_setup_error", channel_id: channelId, list_id: listId, error: String(e) }));
    return;
  }

  try {
    try {
      await runListPostsPoller({
        channelId, listId, accessToken,
        linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    } catch (e) {
      if (!(e instanceof XUnauthorizedError)) throw e;
      accessToken = await tokenService.refreshAccessToken(channelId);
      await runListPostsPoller({
        channelId, listId, accessToken,
        linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT, flowQueue: env.FLOW_QUEUE,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "list_posts_poll_error", channel_id: channelId, list_id: listId, error: String(e) }));
  }
}
