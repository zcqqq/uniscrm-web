export interface ChannelConfig {
  x_user_id: string;
  x_username: string;
  x_name: string;
  access_token: string;
  refresh_token: string;
  expires_at?: string;
  subscription_ids?: string[];
}

export class XTokenService {
  constructor(
    private db: D1Database,
    private clientId: string,
    private clientSecret: string
  ) {}

  async refreshAccessToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");

    const config = JSON.parse(row.config) as ChannelConfig;
    if (!config.refresh_token) throw new Error("No refresh token available");

    const res = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refresh_token,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token refresh failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    config.access_token = data.access_token;
    if (data.refresh_token) {
      config.refresh_token = data.refresh_token;
    }
    if (data.expires_in) {
      config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
    }

    await this.db
      .prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(config), channelId)
      .run();

    return data.access_token;
  }

  async getValidToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");

    const config = JSON.parse(row.config) as ChannelConfig;

    // Proactively refresh if expiring within 10 minutes
    if (config.expires_at) {
      const expiresAt = new Date(config.expires_at).getTime();
      if (Date.now() > expiresAt - 10 * 60 * 1000) {
        return this.refreshAccessToken(channelId);
      }
    }

    return config.access_token;
  }

  async getConfig(channelId: string): Promise<ChannelConfig> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");
    return JSON.parse(row.config) as ChannelConfig;
  }

  async updateConfig(channelId: string, updates: Partial<ChannelConfig>): Promise<void> {
    const config = await this.getConfig(channelId);
    Object.assign(config, updates);
    await this.db
      .prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(config), channelId)
      .run();
  }

  async getAllTwitterChannels(): Promise<Array<{ id: string; config: ChannelConfig }>> {
    const rows = await this.db
      .prepare(`SELECT id, config FROM channels WHERE channel_type IN ('TWITTER', 'X') AND is_active = 1`)
      .all<{ id: string; config: string }>();

    return rows.results.map((r) => ({ id: r.id, config: JSON.parse(r.config) as ChannelConfig }));
  }
}
