/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import { setDefaultModel, setTenantLlmCredentials } from "../src/services/llm-credentials";

// ENCRYPTION_KEY is a secrets_store_secrets binding pointing at a real Cloudflare secret that
// doesn't exist in local test runs (see tests/llm-credentials.test.ts) -- stub it with a
// locally-generated master key for the direct setTenantLlmCredentials() calls below (GET
// /api/image-providers itself never decrypts a key, so it doesn't need this).
const testMasterKey = generateMasterKey();
const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

beforeAll(async () => {
  await seedSession(env as never, "img", 91);
  // vitest-pool-workers does not auto-apply this module's migrations/ directory -- create the
  // post-migration schema by hand, matching migrations/0002_multi_provider_credentials.sql +
  // migrations/0007_image_model.sql.
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
       tenant_id INTEGER NOT NULL,
       provider TEXT NOT NULL,
       encrypted_api_key TEXT,
       model TEXT NOT NULL,
       image_model TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, provider)
     )`
  ).run();
});

async function get() {
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/image-providers", { headers: { Cookie: "session=img" } }),
    env
  );
  return { status: res.status, body: await res.json() as { providers: { provider: string; model: string }[] } };
}

describe("GET /api/image-providers", () => {
  it("always offers default, even for a tenant that never opened the settings page", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.providers).toEqual([{ provider: "default", model: "@cf/black-forest-labs/flux-1-schnell" }]);
  });

  it("omits a BYOK provider that has a key but no image model", async () => {
    await setTenantLlmCredentials(testEnv as never, 91, "openai", "sk-test", "gpt-4.1", null);
    expect((await get()).body.providers.map((p) => p.provider)).toEqual(["default"]);
  });

  it("includes a BYOK provider once an image model is chosen", async () => {
    await setTenantLlmCredentials(testEnv as never, 91, "openai", "sk-test", "gpt-4.1", "gpt-image-1");
    expect((await get()).body.providers).toEqual([
      { provider: "default", model: "@cf/black-forest-labs/flux-1-schnell" },
      { provider: "openai", model: "gpt-image-1" },
    ]);
  });

  it("reflects a changed default image model", async () => {
    await setDefaultModel(env as never, 91, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/bytedance/stable-diffusion-xl-lightning");
    expect((await get()).body.providers[0]).toEqual({ provider: "default", model: "@cf/bytedance/stable-diffusion-xl-lightning" });
  });
});
