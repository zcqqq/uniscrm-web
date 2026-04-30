import type { Platform, TrendItem } from "../types";
import { generateTrendId } from "../types";
import { getTwitterConfig } from "../config";
import type { TrendSource } from "./interface";

export class TwitterTrendSource implements TrendSource {
  platform: Platform = "twitter";

  constructor(private bearerToken: string) {}

  async fetchTrends(): Promise<TrendItem[]> {
    const config = getTwitterConfig();
    if (!config) return [];

    const today = new Date().toISOString().slice(0, 10);
    const allItems: TrendItem[] = [];

    for (const loc of config.locations) {
      try {
        const response = await fetch(
          `https://api.x.com/2/trends/by/woeid/${loc.woeid}`,
          { headers: { Authorization: `Bearer ${this.bearerToken}` } }
        );

        if (!response.ok) continue;

        const body = await response.json() as
          | { trend_name: string; tweet_count?: number; trend_url?: string }[]
          | { data: { trend_name: string; tweet_count?: number; trend_url?: string }[] };
        const trends = Array.isArray(body) ? body : body.data ?? [];

        for (let idx = 0; idx < trends.length; idx++) {
          const trend = trends[idx];
          const id = generateTrendId(today, "twitter", loc.id, trend.trend_name);
          allItems.push({
            id,
            platform: "twitter",
            location: loc.id,
            language: loc.language,
            title: trend.trend_name,
            url: trend.trend_url,
            score: trend.tweet_count ?? (trends.length - idx),
            metrics: { tweet_volume: trend.tweet_count ?? 0 },
            categories: [],
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        continue;
      }
    }

    return allItems;
  }

  async isAvailable(): Promise<boolean> {
    return this.bearerToken.length > 0;
  }
}
