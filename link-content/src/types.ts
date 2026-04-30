export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  NOTION_REDIRECT_URI: string;
}

export type ChannelType = "LOCAL" | "NOTION";
export type ContentStatus = "new" | "pending" | "published" | "ignored";

export interface ContentItemRow {
  id: string;
  user_id: string;
  channel_type: ChannelType;
  channel_source_id: string;
  title: string;
  summary: string | null;
  status: ContentStatus;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelConfigRow {
  id: string;
  user_id: string;
  channel_type: ChannelType;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface OAuthTokenRow {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  channel_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  user_id: string;
  email: string;
  expires_at: string;
}
