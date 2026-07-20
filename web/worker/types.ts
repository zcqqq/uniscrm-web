import type { EmailSender } from "./services/email";

export interface Env {
  WEB_DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  EMAIL_WEB: EmailSender;
  WEBHOOK_SECRET: string;
  WEB_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  LINK_URL: string;
  INTERNAL_SECRET: string;
  ADMIN_URL: string;
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
  tenant_id: number;
  email: string;
  language: string;
  expires_at: string;
}
