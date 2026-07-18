import { Hono } from "hono";
import type { Env } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { ingestYouTubeVideo } from "./services/pollers/youtube-content";

function extractVideoIds(atomXml: string): string[] {
  const ids: string[] = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(atomXml)) !== null) ids.push(m[1]);
  return ids;
}

export function youtubeWebhookRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // WebSub verification handshake: echo hub.challenge back, and persist the granted
  // lease so the renewal cron (Task 8) knows when to re-subscribe.
  router.get("/websub/:channelId", async (c) => {
    const challenge = c.req.query("hub.challenge");
    if (!challenge) return c.text("Missing hub.challenge", 400);

    const channelId = c.req.param("channelId");
    const leaseSeconds = c.req.query("hub.lease_seconds");
    if (leaseSeconds) {
      const row = await c.env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?").bind(channelId).first<{ config: string }>();
      if (row) {
        const config = JSON.parse(row.config) as Record<string, unknown>;
        config.websub_lease_expires_at = new Date(Date.now() + parseInt(leaseSeconds, 10) * 1000).toISOString();
        await c.env.LINK_DB
          .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(config), channelId)
          .run();
      }
    }

    return c.text(challenge);
  });

  router.post("/websub/:channelId", async (c) => {
    const channelId = c.req.param("channelId");
    const body = await c.req.text();
    const videoIds = extractVideoIds(body);
    if (videoIds.length === 0) return c.text("ok");

    const row = await c.env.LINK_DB
      .prepare("SELECT tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE' AND is_active = 1")
      .bind(channelId)
      .first<{ tenant_id: number | null }>();
    if (!row?.tenant_id) {
      console.log(JSON.stringify({ event: "youtube_websub_unknown_channel", channel_id: channelId }));
      return c.text("ok");
    }

    const tenant = await c.env.WEB_DB
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(row.tenant_id)
      .first<{ d1_database_id: string | null }>();
    if (!tenant?.d1_database_id) return c.text("ok");

    const tenantDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenant.d1_database_id);

    for (const videoId of videoIds) {
      try {
        await ingestYouTubeVideo(
          {
            channelId,
            tenantDb,
            tenantId: row.tenant_id,
            ai: c.env.AI,
            vectorize: c.env.VECTORIZE,
            apiKey: c.env.YOUTUBE_API_KEY,
            pipelineContent: c.env.PIPELINE_CONTENT,
            flowQueue: c.env.FLOW_QUEUE,
          },
          videoId
        );
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_websub_ingest_error", channel_id: channelId, video_id: videoId, error: String(e) }));
      }
    }

    return c.text("ok");
  });

  return router;
}
