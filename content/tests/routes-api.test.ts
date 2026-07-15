/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import worker from "../src/index";

beforeAll(async () => {
  // vitest-pool-workers does not auto-apply this module's migrations/ directory (see
  // tests/llm-credentials.test.ts for the same note) -- create the post-migration schema
  // by hand, matching migrations/0001_init.sql.
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
       tenant_id INTEGER PRIMARY KEY,
       provider TEXT NOT NULL,
       encrypted_api_key TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  ).run();
});

describe("GET /api/skills", () => {
  it("returns the skill catalog without requiring auth", async () => {
    const res = await worker.fetch(new Request("https://content-dev.uni-scrm.com/api/skills"), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: { id: string; label: string }[] }>();
    expect(body.skills.map((s) => s.id)).toContain("punchy-social");
  });
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

  it("GET returns null when authed but no credentials set", async () => {
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
    expect(await res.json()).toEqual({ credentials: null });
  });

  it("PUT saves credentials, subsequent GET reports the provider (not the key)", async () => {
    // This test issues two requests (PUT then GET), each of which triggers sessionAuth's
    // internal fetch to WEB_URL/api/auth/me -- mockImplementation (not mockResolvedValue)
    // so each call gets a fresh, unconsumed Response body.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "78" } }), { status: 200 }))
      )
    );
    // ENCRYPTION_KEY is a secrets_store_secrets binding pointing at a real Cloudflare
    // secret that doesn't exist in local test runs (see tests/llm-credentials.test.ts
    // for the same workaround) -- stub it with a locally-generated master key.
    const testMasterKey = generateMasterKey();
    const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

    const putRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT",
        headers: { Cookie: "session=ok", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);

    const getRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      testEnv
    );
    const body = await getRes.json<{ credentials: { provider: string } | null }>();
    expect(body.credentials).toEqual({ provider: "openai" });
  });
});
