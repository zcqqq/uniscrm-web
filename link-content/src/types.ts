import type { TenantDataDB } from "../../shared/tenant-data-db";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  NOTION_REDIRECT_URI: string;
}

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
  member_id: string;
  tenant_id: number;
  email: string;
  language: string;
  expires_at: string;
}

export interface AppContext {
  tenantId: number;
  tenantDataDb: TenantDataDB;
  memberId: string;
  email: string;
}
