export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  APP_URL: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface ContentItem {
  id: string;
  user_id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: "new" | "pending" | "published" | "ignored";
  file_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentMatch {
  content_id: string;
  title: string;
  matches: TrendMatch[];
}

export interface TrendMatch {
  trend_id: string;
  title: string;
  platform: string;
  location: string;
  similarity: number;
}

export interface Session {
  user_id: string;
  email: string;
  expires_at: string;
}
