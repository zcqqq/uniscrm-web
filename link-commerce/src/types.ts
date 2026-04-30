export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  SHOPIFY_REDIRECT_URI: string;
}

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
