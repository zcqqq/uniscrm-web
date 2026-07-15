import type { Env } from "../types";
import { encrypt, decrypt } from "./crypto";

export type LlmProviderName = "openai" | "anthropic";

export interface LlmCredentials {
  provider: LlmProviderName;
  apiKey: string;
}

export async function getTenantLlmCredentials(env: Env, tenantId: number): Promise<LlmCredentials | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT provider, encrypted_api_key FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).first<{ provider: string; encrypted_api_key: string }>();
  if (!row) return null;

  const masterKey = await env.ENCRYPTION_KEY.get();
  const apiKey = await decrypt(row.encrypted_api_key, masterKey);
  return { provider: row.provider as LlmProviderName, apiKey };
}

export async function setTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName,
  apiKey: string
): Promise<void> {
  const masterKey = await env.ENCRYPTION_KEY.get();
  const encryptedApiKey = await encrypt(apiKey, masterKey);
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       provider = excluded.provider,
       encrypted_api_key = excluded.encrypted_api_key,
       updated_at = excluded.updated_at`
  ).bind(tenantId, provider, encryptedApiKey, now, now).run();
}

export async function hasTenantLlmCredentials(env: Env, tenantId: number): Promise<{ provider: string } | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT provider FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).first<{ provider: string }>();
  return row ?? null;
}
