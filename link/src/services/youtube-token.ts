interface YouTubeChannelConfig {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: string;
  [k: string]: unknown;
}

// Unlike X (single-use rotating refresh tokens that revoke the lineage on reuse), Google
// refresh tokens are reusable, so concurrent refreshes are harmless (last-write-wins) and no
// D1 refresh lock is needed here.
export class YouTubeTokenService {
  constructor(
    private db: D1Database,
    private clientId: string,
    private clientSecret: string,
  ) {}

  private async loadConfig(channelId: string): Promise<YouTubeChannelConfig> {
    const row = await this.db.prepare(`SELECT config FROM channels WHERE id = ?`).bind(channelId).first<{ config: string }>();
    if (!row) throw new Error("Channel not found");
    return JSON.parse(row.config) as YouTubeChannelConfig;
  }

  async getValidToken(channelId: string): Promise<string> {
    const config = await this.loadConfig(channelId);
    if (config.expires_at) {
      const msLeft = new Date(config.expires_at).getTime() - Date.now();
      if (msLeft > 10 * 60 * 1000) return config.access_token;
    }
    return this.forceRefresh(channelId);
  }

  async forceRefresh(channelId: string): Promise<string> {
    const config = await this.loadConfig(channelId);
    if (!config.refresh_token) throw new Error("No YouTube refresh token");

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: config.refresh_token,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`YouTube token refresh failed ${res.status}: ${err}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    config.access_token = data.access_token;
    if (data.refresh_token) config.refresh_token = data.refresh_token;
    if (data.expires_in) config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await this.db.prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(config), channelId).run();
    return data.access_token;
  }
}
