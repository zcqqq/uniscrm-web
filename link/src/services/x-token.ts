import { readFrozenState, frozenReason } from "./x-freeze";

export interface ChannelConfig {
  x_user_id: string;
  x_username: string;
  x_name: string;
  access_token: string;
  refresh_token: string;
  expires_at?: string;
  subscription_ids?: string[];
  // Why webhook/subscription setup last failed, or null once it succeeds. Setup runs inside
  // executionCtx.waitUntil after the redirect, so a failure there reaches nobody: the browser
  // has already been sent on its way and the only trace is a console.error that is gone by the
  // time anyone looks. Three separate BYOK setup bugs (2026-07-28) each stayed invisible for
  // exactly this reason — persist the outcome so it can be read off the channel row.
  subscription_error?: string | null;
  subscription_setup_at?: string;
  // Written by the freeze breaker (x-freeze.ts) while X has the account locked or suspended,
  // removed again by the hourly probe once it answers.
  x_frozen_at?: string;
  x_frozen_code?: number;
  x_frozen_message?: string;
}

export class XTokenService {
  constructor(
    private db: D1Database,
    private clientId: string,
    private clientSecret: string
  ) {}

  async refreshAccessToken(channelId: string): Promise<string> {
    // X rotates refresh tokens (single-use) and revokes the entire token
    // lineage if it ever sees one reused. Cron's hourly proactive refresh and
    // a poller's reactive 401-retry can otherwise both read the same stored
    // refresh_token and submit it concurrently, permanently breaking the
    // channel. Claim an exclusive lock first so only one caller ever calls
    // the token endpoint for this channel at a time.
    const lockClaim = await this.db
      .prepare(
        `UPDATE channels SET token_refresh_lock_until = datetime('now', '+30 seconds')
         WHERE id = ? AND (token_refresh_lock_until IS NULL OR token_refresh_lock_until < datetime('now'))`
      )
      .bind(channelId)
      .run();

    if (lockClaim.meta.changes === 0) {
      // Someone else is refreshing this channel right now — wait for them to
      // finish and adopt whatever they stored instead of racing them.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const row = await this.db.prepare(`SELECT config FROM channels WHERE id = ?`).bind(channelId).first<{ config: string }>();
      if (!row) throw new Error("Channel not found");
      return (JSON.parse(row.config) as ChannelConfig).access_token;
    }

    try {
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
    } finally {
      await this.db
        .prepare(`UPDATE channels SET token_refresh_lock_until = NULL WHERE id = ?`)
        .bind(channelId)
        .run();
    }
  }

  async getValidToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config, is_active FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string; is_active: number }>();

    if (!row) throw new Error("Channel not found");

    // A deactivated channel must never reach the X API. When X freezes/suspends an account,
    // every further call carrying that account's token risks extending the freeze — so
    // `is_active = 0` doubles as the pause switch. Cron and the pollers already filter on it;
    // this is the backstop for the flow-driven paths (x/action, content/create-post,
    // content/x-video-status) that look a channel up by id alone.
    if (!row.is_active) throw new Error(`channel_inactive: channel ${channelId} is deactivated`);

    const config = JSON.parse(row.config) as ChannelConfig;

    // X locked or suspended the account — every further call risks lengthening the lock, so
    // hand out no token at all. The hourly probe in cron.ts clears this by itself once the
    // account answers again (see x-freeze.ts); nothing here needs un-pausing by hand.
    const frozen = readFrozenState(config as unknown as Record<string, unknown>);
    if (frozen) throw new Error(frozenReason(frozen));

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
