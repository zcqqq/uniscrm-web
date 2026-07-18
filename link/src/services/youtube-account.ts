import type { Env } from "../types";
import { fetchAllSubscriptions, subscribeWebSub } from "./youtube-api";

export async function syncYouTubeSubscriptions(env: Env, channelId: string, accessToken: string): Promise<void> {
  const row = await env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?").bind(channelId).first<{ config: string }>();
  if (!row) return;

  const config = JSON.parse(row.config) as Record<string, unknown>;
  try {
    const subscriptions = await fetchAllSubscriptions(accessToken);
    config.subscriptions = subscriptions;
    config.sync_status = "done";
    config.last_synced_at = new Date().toISOString();
  } catch (e) {
    console.error(JSON.stringify({ event: "youtube_subscriptions_sync_error", channel_id: channelId, error: String(e) }));
    config.sync_status = "error";
  }

  await env.LINK_DB
    .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(config), channelId)
    .run();
}

export interface WatchChannelResult {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

// Tenant-scoped source_channel_id, same reasoning as YOUTUBE_ACCOUNT rows: the shared
// channels(channel_type, source_channel_id) unique index (link/migrations/0001_initial_schema.sql)
// is global and must not be migrated — two tenants watching the same external channel each
// need their own row.
export async function findOrCreateWatchedChannel(
  env: Env,
  tenantId: number,
  memberId: string,
  youtubeChannelId: string,
  channelName: string,
  thumbnailUrl: string
): Promise<WatchChannelResult> {
  const sourceChannelId = `${tenantId}:${youtubeChannelId}`;
  const config = { youtube_channel_id: youtubeChannelId, channel_name: channelName, thumbnail_url: thumbnailUrl };
  const now = new Date().toISOString();

  const existing = await env.LINK_DB
    .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE' AND source_channel_id = ? AND is_active = 1")
    .bind(sourceChannelId)
    .first<{ id: string }>();

  let channelId: string;
  if (existing) {
    channelId = existing.id;
    await env.LINK_DB
      .prepare("UPDATE channels SET config = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(config), now, channelId)
      .run();
  } else {
    channelId = crypto.randomUUID();
    await env.LINK_DB
      .prepare(
        `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'YOUTUBE', ?, ?, ?, ?, ?, ?)`
      )
      .bind(channelId, JSON.stringify(config), sourceChannelId, tenantId, memberId, now, now)
      .run();

    try {
      await subscribeWebSub(`${env.LINK_URL}/youtube/websub/${channelId}`, youtubeChannelId);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_websub_subscribe_error", channel_id: channelId, error: String(e) }));
    }
  }

  return { channelId, channelName, thumbnailUrl };
}
