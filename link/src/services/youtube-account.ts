import type { Env } from "../types";
import { fetchAllSubscriptions } from "./youtube-api";

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
