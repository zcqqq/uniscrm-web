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

  // WebSub verification handshake: echo hub.challenge back, and upsert the granted lease
  // into youtube_websub_leases (keyed on the account + subscribed-channel pair, not a
  // channels-table row) so the renewal cron knows when to re-subscribe.
  router.get("/websub/:accountChannelId/:youtubeChannelId", async (c) => {
    const challenge = c.req.query("hub.challenge");
    if (!challenge) return c.text("Missing hub.challenge", 400);

    const accountChannelId = c.req.param("accountChannelId");
    const youtubeChannelId = c.req.param("youtubeChannelId");
    const leaseSeconds = c.req.query("hub.lease_seconds");
    if (leaseSeconds) {
      const accountRow = await c.env.LINK_DB
        .prepare("SELECT tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT' AND is_active = 1")
        .bind(accountChannelId)
        .first<{ tenant_id: number }>();
      if (accountRow) {
        const leaseExpiresAt = new Date(Date.now() + parseInt(leaseSeconds, 10) * 1000).toISOString();
        await c.env.LINK_DB
          .prepare(
            `INSERT INTO youtube_websub_leases (id, tenant_id, account_channel_id, youtube_channel_id, lease_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(account_channel_id, youtube_channel_id) DO UPDATE SET
               lease_expires_at = excluded.lease_expires_at, updated_at = datetime('now')`
          )
          .bind(crypto.randomUUID(), accountRow.tenant_id, accountChannelId, youtubeChannelId, leaseExpiresAt)
          .run();
      }
    }

    return c.text(challenge);
  });

  router.post("/websub/:accountChannelId/:youtubeChannelId", async (c) => {
    const accountChannelId = c.req.param("accountChannelId");
    const youtubeChannelId = c.req.param("youtubeChannelId");
    const body = await c.req.text();
    const videoIds = extractVideoIds(body);
    if (videoIds.length === 0) return c.text("ok");

    const row = await c.env.LINK_DB
      .prepare(
        `SELECT c.tenant_id as tenant_id
         FROM youtube_websub_leases l
         JOIN channels c ON c.id = l.account_channel_id
         WHERE l.account_channel_id = ? AND l.youtube_channel_id = ? AND c.is_active = 1`
      )
      .bind(accountChannelId, youtubeChannelId)
      .first<{ tenant_id: number | null }>();
    if (!row?.tenant_id) {
      console.log(JSON.stringify({ event: "youtube_websub_unknown_lease", account_channel_id: accountChannelId, youtube_channel_id: youtubeChannelId }));
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
            accountChannelId,
            subscriptionChannelId: youtubeChannelId,
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
        console.error(JSON.stringify({ event: "youtube_websub_ingest_error", account_channel_id: accountChannelId, subscription_channel_id: youtubeChannelId, video_id: videoId, error: String(e) }));
      }
    }

    return c.text("ok");
  });

  return router;
}
