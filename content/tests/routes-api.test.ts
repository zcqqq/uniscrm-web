/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";

beforeAll(async () => {
  // sessionAuth resolves sessions from the WEB_DB binding (shared/auth.ts), not via an
  // HTTP hop to web — seed one session per tenant this file uses.
  await seedSession(env as never, "sess-77", 77);
  await seedSession(env as never, "sess-78", 78);
  await seedSession(env as never, "sess-79", 79);
  await seedSession(env as never, "ok", 80);
  // vitest-pool-workers does not auto-apply this module's migrations/ directory (see
  // tests/llm-credentials.test.ts for the same note) -- create the post-migration schema
  // by hand, matching migrations/0002_multi_provider_credentials.sql +
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

describe("/api/llm-credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET returns 401 when the session check fails", async () => {
    // "bad" has no sessions row, so shared/auth.ts's resolveSession rejects it.
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=bad" } }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("GET returns an empty list when authed but nothing configured", async () => {
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 77`).run();

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=sess-77" } }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      providers: [],
      defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      defaultImageModel: "@cf/black-forest-labs/flux-1-schnell",
    });
  });

  it("PUT saves a provider, GET lists it (with model, never the key)", async () => {
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 78`).run();

    // ENCRYPTION_KEY is a secrets_store_secrets binding pointing at a real Cloudflare secret that
    // doesn't exist in local test runs (see tests/llm-credentials.test.ts) -- stub it with a
    // locally-generated master key.
    const testMasterKey = generateMasterKey();
    const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

    const putRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT",
        headers: { Cookie: "session=sess-78", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" }),
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);

    const getRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=sess-78" } }),
      testEnv
    );
    expect(await getRes.json()).toEqual({
      providers: [{ provider: "openai", model: "gpt-4o-mini", imageModel: null, createdAt: expect.any(String) }],
      defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      defaultImageModel: "@cf/black-forest-labs/flux-1-schnell",
    });
  });

  it("round-trips imageModel through PUT and GET", async () => {
    const testMasterKey = generateMasterKey();
    const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };
    await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT", headers: { Cookie: "session=ok", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-x", model: "gpt-4.1", imageModel: "gpt-image-1" }),
      }),
      testEnv
    );
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      testEnv
    );
    const body = await res.json() as { providers: { provider: string; imageModel: string | null }[]; defaultImageModel: string };
    expect(body.providers.find((p) => p.provider === "openai")?.imageModel).toBe("gpt-image-1");
    expect(body.defaultImageModel).toBe("@cf/black-forest-labs/flux-1-schnell");
  });

  it("DELETE removes a provider", async () => {
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 79`).run();
    await env.CONTENT_DB.prepare(
      `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at) VALUES (79, 'openai', 'x', 'gpt-4o-mini', datetime('now'), datetime('now'))`
    ).run();

    const delRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials/openai", { method: "DELETE", headers: { Cookie: "session=sess-79" } }),
      env
    );
    expect(delRes.status).toBe(200);

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 79`).first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});
