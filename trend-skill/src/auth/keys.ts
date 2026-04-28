import type { Tier } from "../types";

export interface ApiKey {
  key: string;
  tier: Tier;
  owner_name: string | null;
  created_at: string;
  expires_at: string | null;
  is_active: number;
}

export class ApiKeyService {
  constructor(private db: D1Database) {}

  async create(tier: Tier = "free", ownerName?: string): Promise<ApiKey> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const key = `sk_trend_${hex}`;
    const now = new Date().toISOString();

    await this.db
      .prepare("INSERT INTO api_keys (key, tier, owner_name, created_at) VALUES (?, ?, ?, ?)")
      .bind(key, tier, ownerName ?? null, now)
      .run();

    return { key, tier, owner_name: ownerName ?? null, created_at: now, expires_at: null, is_active: 1 };
  }

  async get(key: string): Promise<ApiKey | null> {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE key = ?")
      .bind(key)
      .first<ApiKey>();
  }

  async updateTier(key: string, tier: Tier): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET tier = ? WHERE key = ?")
      .bind(tier, key)
      .run();
  }

  async deactivate(key: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET is_active = 0 WHERE key = ?")
      .bind(key)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM api_keys WHERE key = ?")
      .bind(key)
      .run();
  }
}
