import type { ApiKeyRecord, Tier } from "../types";

function generateKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk_trend_${hex}`;
}

export class ApiKeyService {
  constructor(private db: D1Database) {}

  async create(tier: Tier, ownerName?: string): Promise<string> {
    const key = generateKey();
    const now = new Date().toISOString();
    await this.db
      .prepare("INSERT INTO api_keys (key, tier, owner_name, created_at) VALUES (?, ?, ?, ?)")
      .bind(key, tier, ownerName ?? null, now)
      .run();
    return key;
  }

  async get(key: string): Promise<ApiKeyRecord | null> {
    return await this.db
      .prepare("SELECT * FROM api_keys WHERE key = ?")
      .bind(key)
      .first<ApiKeyRecord>();
  }

  async updateTier(key: string, tier: Tier): Promise<void> {
    await this.db.prepare("UPDATE api_keys SET tier = ? WHERE key = ?").bind(tier, key).run();
  }

  async deactivate(key: string): Promise<void> {
    await this.db.prepare("UPDATE api_keys SET is_active = 0 WHERE key = ?").bind(key).run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM api_keys WHERE key = ?").bind(key).run();
  }
}
