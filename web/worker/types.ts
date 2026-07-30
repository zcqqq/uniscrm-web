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
  // 密码登录的按 IP 限流。原生 Workers Rate Limiting binding；计数器落在触发请求的那个 Cloudflare
  // 边缘节点本地，不是全局的——同一 IP 打到不同边缘节点会各自计数，这里接受这个折衷。
  // 本地 wrangler dev 与现有单测的 mock env 都没有这个 binding，调用处必须显式容错。
  LOGIN_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
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
