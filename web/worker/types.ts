export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  LINK_SOCIAL_URL: string;
  INTERNAL_SECRET: string;
}

export interface Tenant {
  id: string;
  email: string;
  created_at: string;
}

export interface Member {
  id: string;
  tenant_id: string;
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
  member_id: string;
  tenant_id: string;
  email: string;
  expires_at: string;
}
