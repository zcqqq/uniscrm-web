/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import {
  getTenantLlmCredentials,
  setTenantLlmCredentials,
  listConfiguredProviders,
  deleteTenantLlmCredentials,
  getDefaultModel,
  setDefaultModel,
} from "../src/services/llm-credentials";

describe("multi-provider tenant LLM credentials", () => {
  const testMasterKey = generateMasterKey();
  const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory (no
    // <BINDING>_MIGRATIONS binding is wired up, and there's no setupFiles hook calling
    // applyD1Migrations) -- create the post-migration schema by hand, matching
    // migrations/0002_multi_provider_credentials.sql, mirroring the established pattern in
    // flow/tests/unit/flows-list.test.ts and flow/tests/unit/queue-content.test.ts.
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
         tenant_id INTEGER NOT NULL,
         provider TEXT NOT NULL,
         encrypted_api_key TEXT,
         model TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (tenant_id, provider)
       )`
    ).run();
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials`).run();
  });

  it("returns null for a provider with no credentials set", async () => {
    expect(await getTenantLlmCredentials(testEnv as any, 42, "openai")).toBeNull();
  });

  it("round-trips provider + api key + model through encryption", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123", "gpt-4o-mini");
    const creds = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(creds).toEqual({ apiKey: "sk-test-123", model: "gpt-4o-mini" });
  });

  it("stores openai and anthropic independently for the same tenant", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");

    const openai = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    const anthropic = await getTenantLlmCredentials(testEnv as any, 42, "anthropic");
    expect(openai).toEqual({ apiKey: "sk-openai", model: "gpt-4o-mini" });
    expect(anthropic).toEqual({ apiKey: "sk-anthropic", model: "claude-3-5-haiku-latest" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42`).first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("upserts on a second call for the same (tenant, provider) pair", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-old", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-new", "gpt-4o");
    const creds = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(creds).toEqual({ apiKey: "sk-new", model: "gpt-4o" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42 AND provider = 'openai'`).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("listConfiguredProviders reports provider+model without decrypting, for all configured providers", async () => {
    expect(await listConfiguredProviders(testEnv as any, 42)).toEqual([]);
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");
    const list = await listConfiguredProviders(testEnv as any, 42);
    expect(list.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
      { provider: "anthropic", model: "claude-3-5-haiku-latest", createdAt: expect.any(String) },
      { provider: "openai", model: "gpt-4o-mini", createdAt: expect.any(String) },
    ]);
  });

  it("deleteTenantLlmCredentials removes only the specified provider", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");
    await deleteTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(await getTenantLlmCredentials(testEnv as any, 42, "openai")).toBeNull();
    expect(await getTenantLlmCredentials(testEnv as any, 42, "anthropic")).toEqual({ apiKey: "sk-anthropic", model: "claude-3-5-haiku-latest" });
  });

  it("getDefaultModel returns the hardcoded fallback when the tenant never set one", async () => {
    expect(await getDefaultModel(testEnv as any, 42)).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("setDefaultModel persists a model choice with no API key, getDefaultModel returns it", async () => {
    await setDefaultModel(testEnv as any, 42, "@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(await getDefaultModel(testEnv as any, 42)).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");

    const row = await env.CONTENT_DB.prepare(
      `SELECT encrypted_api_key FROM tenant_llm_credentials WHERE tenant_id = 42 AND provider = 'default'`
    ).first<{ encrypted_api_key: string | null }>();
    expect(row?.encrypted_api_key).toBeNull();
  });

  it("listConfiguredProviders excludes 'default' even when a default model is set, and includes createdAt for openai/anthropic", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setDefaultModel(testEnv as any, 42, "@cf/meta/llama-4-scout-17b-16e-instruct");
    const list = await listConfiguredProviders(testEnv as any, 42);
    expect(list.find((p) => p.provider === "default")).toBeUndefined();
    expect(list).toEqual([{ provider: "openai", model: "gpt-4o-mini", createdAt: expect.any(String) }]);
  });
});
