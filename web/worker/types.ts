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
  preferred_location: string;
  created_at: string;
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
