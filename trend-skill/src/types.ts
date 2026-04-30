export type Platform = "twitter" | "tiktok" | "douyin" | "weibo" | "baidu";

export type Tier = "anonymous" | "free" | "premium";

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

export interface AuthResult {
  tier: Tier;
  identifier: string;
}

export interface AuthError {
  error: string;
  status: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface DigestPayload {
  event: "trend.daily_digest";
  timestamp: string;
  data: {
    persistent_topics: PersistentTopic[];
    cross_platform_topics: CrossPlatformTopic[];
  };
}

export interface PersistentTopic {
  title: string;
  platform: string;
  location: string;
  days_trending: number;
  current_score: number;
  url?: string;
}

export interface CrossPlatformTopic {
  title: string;
  platforms: string[];
  location: string;
  similarity: number;
  url?: string;
}

export interface Env {
  TREND_KV: KVNamespace;
  TREND_DB: D1Database;
  TREND_VECTORIZE: VectorizeIndex;
  AI: Ai;
  ADMIN_SECRET: string;
}

export const PLATFORM_SHORT: Record<Platform, string> = {
  twitter: "tw",
  tiktok: "tk",
  douyin: "dy",
  weibo: "wb",
  baidu: "bd",
};

export { LOCATION_SHORT } from "./config/locations";

export const TIER_RATE_LIMITS: Record<Tier, number> = {
  anonymous: 10,
  free: 30,
  premium: 300,
};
