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

export interface RecommendationGroup {
  trend?: { id: string; title: string; platform: string; score: number; similarity: number };
  content?: { id: string; title: string; similarity: number };
  product?: { id: string; title: string; similarity: number };
  sort_score: number;
}

export interface Session {
  user_id: string;
  email: string;
  expires_at: string;
}
