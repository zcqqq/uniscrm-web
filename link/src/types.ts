export interface Pipeline {
  send(records: Record<string, unknown>[]): Promise<void>;
}

export interface Env {
  LINK_DB: D1Database;
  WEB_DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  MAIGRET_QUEUE: Queue;
  FLOW_QUEUE: Queue;
  PIPELINE_EVENT: Pipeline;
  PIPELINE_USER: Pipeline;

  // Config
  TREND_RETENTION_DAYS: string;
  WEB_URL: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  INTERNAL_SECRET: string;

  // X / Twitter
  TWITTER_BEARER_TOKEN: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_CONSUMER_SECRET: string;

  // TikTok
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  TIKTOK_COOKIE: string;

  // Notion
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  NOTION_REDIRECT_URI: string;

  // Shopify
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  SHOPIFY_REDIRECT_URI: string;

  // Trend sources
  FIRECRAWL_API_KEY: string;
  DOUYIN_COOKIE: string;
}

export interface Session {
  member_id: string;
  tenant_id: number;
  email: string;
}

// Content types
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK";
export type ContentStatus = "new" | "pending" | "published" | "ignored";

export interface ContentRow {
  id: string;
  channel_type: ChannelType;
  source_content_id: string;
  title: string;
  summary: string | null;
  status: ContentStatus;
  source_url: string | null;
  source_updated_at: string | null;
  raw_data: string;
  created_at: string;
  updated_at: string;
}

// Commerce types
export type CommerceChannelType = "LINK" | "SHOPIFY";

export interface ProductRow {
  id: string;
  user_id: string;
  channel_type: CommerceChannelType;
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

