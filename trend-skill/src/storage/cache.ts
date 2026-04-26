import type { TrendItem } from "../types";

const TTL_SECONDS = 900; // 15 minutes

export class TrendCache {
  constructor(private kv: KVNamespace) {}

  async getLatest(): Promise<TrendItem[] | null> {
    const raw = await this.kv.get("trends:latest");
    return raw ? JSON.parse(raw) : null;
  }

  async setLatest(items: TrendItem[]): Promise<void> {
    await this.kv.put("trends:latest", JSON.stringify(items), { expirationTtl: TTL_SECONDS });
  }

  async getPlatformLatest(platform: string): Promise<TrendItem[] | null> {
    const raw = await this.kv.get(`trends:${platform}:latest`);
    return raw ? JSON.parse(raw) : null;
  }

  async setPlatformLatest(platform: string, items: TrendItem[]): Promise<void> {
    await this.kv.put(`trends:${platform}:latest`, JSON.stringify(items), {
      expirationTtl: TTL_SECONDS,
    });
  }
}
