import type { Env } from "../types";
import { encrypt, decrypt } from "./crypto";

export type LlmProviderName = "openai" | "anthropic";

export interface LlmCredentials {
  apiKey: string;
  model: string;
}

export async function getTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName
): Promise<LlmCredentials | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT encrypted_api_key, model FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = ?"
  ).bind(tenantId, provider).first<{ encrypted_api_key: string; model: string }>();
  if (!row) return null;

  const masterKey = await env.ENCRYPTION_KEY.get();
  const apiKey = await decrypt(row.encrypted_api_key, masterKey);
  return { apiKey, model: row.model };
}

export async function setTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName,
  apiKey: string,
  model: string
): Promise<void> {
  const masterKey = await env.ENCRYPTION_KEY.get();
  const encryptedApiKey = await encrypt(apiKey, masterKey);
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider) DO UPDATE SET
       encrypted_api_key = excluded.encrypted_api_key,
       model = excluded.model,
       updated_at = excluded.updated_at`
  ).bind(tenantId, provider, encryptedApiKey, model, now, now).run();
}

export async function listConfiguredProviders(
  env: Env,
  tenantId: number
): Promise<{ provider: string; model: string }[]> {
  const rows = await env.CONTENT_DB.prepare(
    "SELECT provider, model FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).all<{ provider: string; model: string }>();
  return rows.results;
}

export async function deleteTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName
): Promise<void> {
  await env.CONTENT_DB.prepare(
    "DELETE FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = ?"
  ).bind(tenantId, provider).run();
}
