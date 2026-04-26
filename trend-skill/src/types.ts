export type Platform = "twitter" | "weibo" | "douyin" | "baidu";

export type WriteFormat = "tweet" | "thread" | "article" | "summary" | "headline";

export type Tier = "free" | "premium";

export interface TrendItem {
  id: string;
  platform: Platform;
  title: string;
  description?: string;
  url: string;
  score: number;
  rawMetrics: Record<string, number>;
  categories: string[];
  timestamp: string;
}

export interface TrendSearchResult {
  item: TrendItem;
  similarity: number;
}

export interface WriteContext {
  trends: TrendItem[];
  template: string;
  format: WriteFormat;
  platform?: string;
  locale: string;
}

export interface ApiKeyRecord {
  key: string;
  tier: Tier;
  owner_name: string | null;
  created_at: string;
  expires_at: string | null;
  is_active: number;
}

export interface Env {
  TREND_KV: KVNamespace;
  TREND_DB: D1Database;
  TREND_VECTORIZE: VectorizeIndex;
  AI: Ai;
  TWITTER_BEARER_TOKEN: string;
  ADMIN_SECRET: string;
}
