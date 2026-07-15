/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("POST /internal/generate", () => {
  // Stub env.AI.run so this route test stays deterministic and free: every other test in this
  // module mocks the Workers AI call the same way (see generate.test.ts), since the real remote
  // binding is Task 4/5's concern (already covered by tests/providers/workers-ai.test.ts) and
  // hitting it here made the full suite flaky (~25% fail rate under parallel test-file load,
  // including a genuine 502 from a slow/failed upstream round-trip, not just a timeout).
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
    AI: { run: async () => ({ response: "generated text" }) } as unknown as Ai,
  };

  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply migrations/ (see tests/llm-credentials.test.ts) --
    // create the post-migration schema by hand so generateContent's BYOK lookup (a plain SELECT
    // against tenant_llm_credentials) doesn't fail with "no such table" for a tenant with no key.
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

  afterEach(() => vi.unstubAllGlobals());

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, skillId: "punchy-social", material: {}, targetPlatform: "X" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns generated text on success (Workers AI fallback, no BYOK key seeded)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({
          tenantId: 999,
          skillId: "punchy-social",
          material: { content_text: "hello world" },
          targetPlatform: "X",
        }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(typeof body.text).toBe("string");
  });

  it("returns 400 for an unknown skillId", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, skillId: "nope", material: {}, targetPlatform: "X" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, material: {} }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });
});
