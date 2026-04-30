import type { OAuthTokenRow } from "../types";

export class OAuthService {
  constructor(private db: D1Database) {}

  async getToken(userId: string, provider: string): Promise<OAuthTokenRow | null> {
    return this.db
      .prepare("SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .first<OAuthTokenRow>();
  }

  async saveToken(
    userId: string,
    provider: string,
    token: {
      access_token: string;
      refresh_token?: string | null;
      expires_at?: string | null;
      channel_name?: string | null;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, channel_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           channel_name = excluded.channel_name,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        userId,
        provider,
        token.access_token,
        token.refresh_token ?? null,
        token.expires_at ?? null,
        token.channel_name ?? null,
        now,
        now
      )
      .run();
  }

  async deleteToken(userId: string, provider: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .run();
  }
}
