import type { TrendItem } from "../types";

export class TrendCache {
  constructor(private kv: KVNamespace) {}

  async getLatest(): Promise<TrendItem[] | null> {
    const raw = await this.kv.get("trends:latest");
    return raw ? JSON.parse(raw) : null;
  }

  async setLatest(items: TrendItem[]): Promise<void> {
    await this.kv.put("trends:latest", JSON.stringify(items));
  }

  async getPlatformLatest(platform: string, location: string): Promise<TrendItem[] | null> {
    const raw = await this.kv.get(`trends:${platform}:${location}:latest`);
    return raw ? JSON.parse(raw) : null;
  }

  async setPlatformLatest(platform: string, location: string, items: TrendItem[]): Promise<void> {
    await this.kv.put(`trends:${platform}:${location}:latest`, JSON.stringify(items));
  }
}
