/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import { getTenantLlmCredentials, setTenantLlmCredentials, hasTenantLlmCredentials } from "../src/services/llm-credentials";

describe("tenant LLM credentials", () => {
  const testMasterKey = generateMasterKey();
  const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory (no
    // <BINDING>_MIGRATIONS binding is wired up, and there's no setupFiles hook calling
    // applyD1Migrations) -- create the post-migration schema by hand, matching
    // migrations/0001_init.sql, mirroring the established pattern in
    // flow/tests/unit/flows-list.test.ts and flow/tests/unit/queue-content.test.ts.
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
         tenant_id INTEGER PRIMARY KEY,
         provider TEXT NOT NULL,
         encrypted_api_key TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    ).run();
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials`).run();
  });

  it("returns null when no credentials are set for the tenant", async () => {
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toBeNull();
  });

  it("round-trips provider + api key through encryption", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123");
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toEqual({ provider: "openai", apiKey: "sk-test-123" });
  });

  it("upserts on a second call for the same tenant (single active provider+key)", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-old");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-new");
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toEqual({ provider: "anthropic", apiKey: "sk-new" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42`).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("hasTenantLlmCredentials reports provider without decrypting", async () => {
    expect(await hasTenantLlmCredentials(testEnv as any, 42)).toBeNull();
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123");
    expect(await hasTenantLlmCredentials(testEnv as any, 42)).toEqual({ provider: "openai" });
  });
});
