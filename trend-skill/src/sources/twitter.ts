import type { TrendItem } from "../types";
import type { TrendSource, FetchTrendsOptions } from "./interface";

type FetchFn = typeof globalThis.fetch;

interface TwitterTrend {
  trend_name: string;
  tweet_count: number;
}

interface TwitterTrendsResponse {
  data: TwitterTrend[];
}

const TWITTER_TRENDS_URL = "https://api.x.com/2/trends/by/woeid/1";

export class TwitterTrendSource implements TrendSource {
  platform = "twitter" as const;
  private bearerToken: string;
  private fetchFn: FetchFn;

  constructor(bearerToken: string, fetchFn: FetchFn = globalThis.fetch) {
    this.bearerToken = bearerToken;
    this.fetchFn = fetchFn;
  }

  async fetchTrends(options?: FetchTrendsOptions): Promise<TrendItem[]> {
    try {
      const resp = await this.fetchFn(TWITTER_TRENDS_URL, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      if (!resp.ok) return [];

      const body = (await resp.json()) as TwitterTrendsResponse;
      const now = new Date().toISOString();

      let items: TrendItem[] = body.data.map((trend) => ({
        id: `twitter:${encodeURIComponent(trend.trend_name)}`,
        platform: "twitter",
        title: trend.trend_name,
        url: `https://x.com/search?q=${encodeURIComponent(trend.trend_name)}`,
        score: 0,
        rawMetrics: { tweet_volume: trend.tweet_count },
        categories: [],
        timestamp: now,
      }));

      if (options?.limit && options.limit < items.length) {
        items = items.slice(0, options.limit);
      }

      return items;
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await this.fetchFn(TWITTER_TRENDS_URL, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
