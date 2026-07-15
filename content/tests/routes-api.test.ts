/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import worker from "../src/index";

beforeAll(async () => {
  // vitest-pool-workers does not auto-apply this module's migrations/ directory (see
  // tests/llm-credentials.test.ts for the same note) -- create the post-migration schema
  // by hand, matching migrations/0002_multi_provider_credentials.sql.
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
       tenant_id INTEGER NOT NULL,
       provider TEXT NOT NULL,
       encrypted_api_key TEXT NOT NULL,
       model TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, provider)
     )`
  ).run();
});

describe("/api/llm-credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET returns 401 when the session check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=bad" } }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("GET returns an empty list when authed but nothing configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "77" } }), { status: 200 }))
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 77`).run();

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  it("PUT saves a provider, GET lists it (with model, never the key)", async () => {
    // Each of the two requests below (PUT then GET) triggers sessionAuth's internal fetch to
    // WEB_URL/api/auth/me -- use mockImplementation (not mockResolvedValue) so each call gets a
    // fresh, unconsumed Response body (see tests/llm-credentials.test.ts / prior version of this
    // file for the same "body already used" pitfall).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "78" } }), { status: 200 }))
      )
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 78`).run();

    // ENCRYPTION_KEY is a secrets_store_secrets binding pointing at a real Cloudflare secret that
    // doesn't exist in local test runs (see tests/llm-credentials.test.ts) -- stub it with a
    // locally-generated master key.
    const testMasterKey = generateMasterKey();
    const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

    const putRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT",
        headers: { Cookie: "session=ok", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" }),
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);

    const getRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      testEnv
    );
    expect(await getRes.json()).toEqual({ providers: [{ provider: "openai", model: "gpt-4o-mini" }] });
  });

  it("DELETE removes a provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "79" } }), { status: 200 }))
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 79`).run();
    await env.CONTENT_DB.prepare(
      `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at) VALUES (79, 'openai', 'x', 'gpt-4o-mini', datetime('now'), datetime('now'))`
    ).run();

    const delRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials/openai", { method: "DELETE", headers: { Cookie: "session=ok" } }),
      env
    );
    expect(delRes.status).toBe(200);

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 79`).first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});
