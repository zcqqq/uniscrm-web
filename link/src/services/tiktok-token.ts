export interface TikTokChannelConfig {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
}

export class TikTokTokenService {
  constructor(
    private db: D1Database,
    private clientKey: string,
    private clientSecret: string
  ) {}

  async refreshAccessToken(channelId: string): Promise<string> {
    // Same single-use-refresh-token race as XTokenService: claim an exclusive
    // lock so cron's proactive refresh and a poller's reactive 401-retry never
    // submit the same refresh_token to TikTok concurrently.
    const lockClaim = await this.db
      .prepare(
        `UPDATE channels SET token_refresh_lock_until = datetime('now', '+30 seconds')
         WHERE id = ? AND (token_refresh_lock_until IS NULL OR token_refresh_lock_until < datetime('now'))`
      )
      .bind(channelId)
      .run();

    if (lockClaim.meta.changes === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const row = await this.db.prepare(`SELECT config FROM channels WHERE id = ?`).bind(channelId).first<{ config: string }>();
      if (!row) throw new Error("Channel not found");
      return (JSON.parse(row.config) as TikTokChannelConfig).access_token;
    }

    try {
      const row = await this.db
        .prepare(`SELECT config FROM channels WHERE id = ?`)
        .bind(channelId)
        .first<{ config: string }>();

      if (!row) throw new Error("Channel not found");

      const config = JSON.parse(row.config) as TikTokChannelConfig;
      if (!config.refresh_token) throw new Error("No refresh token available");

      const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: this.clientKey,
          client_secret: this.clientSecret,
          grant_type: "refresh_token",
          refresh_token: config.refresh_token,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`TikTok token refresh failed ${res.status}: ${err}`);
      }

      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };

      config.access_token = data.access_token;
      if (data.refresh_token) config.refresh_token = data.refresh_token;
      if (data.expires_in) config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();

      await this.db
        .prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(JSON.stringify(config), channelId)
        .run();

      return data.access_token;
    } finally {
      await this.db
        .prepare(`UPDATE channels SET token_refresh_lock_until = NULL WHERE id = ?`)
        .bind(channelId)
        .run();
    }
  }

  async getValidToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");

    const config = JSON.parse(row.config) as TikTokChannelConfig;

    if (config.expires_at) {
      const expiresAt = new Date(config.expires_at).getTime();
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() > expiresAt - tenMinutes) {
        return this.refreshAccessToken(channelId);
      }
    }

    return config.access_token;
  }
}
