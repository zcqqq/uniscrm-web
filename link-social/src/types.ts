export type Platform = "twitter" | "tiktok" | "douyin" | "weibo" | "baidu";

export interface TrendItem {
  id: string;
  platform: Platform;
  location: string;
  language: string;
  title: string;
  description?: string;
  url?: string;
  score: number;
  metrics: Record<string, number>;
  categories: string[];
  timestamp: string;
}

export interface TrendSearchResult {
  item: TrendItem;
  similarity: number;
}

export interface AggregatorResult {
  items: TrendItem[];
  failedPlatforms: Platform[];
}

export interface Env {
  TREND_KV: KVNamespace;
  TREND_VECTORIZE: VectorizeIndex;
  AI: Ai;
  DB: D1Database;
  ASSETS: Fetcher;
  TWITTER_BEARER_TOKEN: string;
  FIRECRAWL_API_KEY: string;
  TIKTOK_COOKIE: string;
  DOUYIN_COOKIE: string;
  TREND_RETENTION_DAYS: string;
  MAIGRET_QUEUE: Queue;
  FLOW_QUEUE: Queue;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_CONSUMER_SECRET: string;
  INTERNAL_SECRET: string;
  WEB_URL: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
}

export const PLATFORM_SHORT: Record<Platform, string> = {
  twitter: "tw",
  tiktok: "tk",
  douyin: "dy",
  weibo: "wb",
  baidu: "bd",
};

export const LOCATION_SHORT: Record<string, string> = {
  global: "gl",
  china: "cn",
  all_regions: "ar",
  united_states: "us",
};

export function generateTrendId(
  date: string,
  platform: Platform,
  location: string,
  title: string
): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(title);
  let h = 0x811c9dc5;
  for (const byte of data) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const ps = PLATFORM_SHORT[platform];
  const ls = LOCATION_SHORT[location] ?? location.slice(0, 2);
  return `${date}:${ps}:${ls}:${hex}`;
}
