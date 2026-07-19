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
    // create the post-migration schema by hand (matching migrations/0002_multi_provider_credentials.sql)
    // so generateContent's BYOK lookup (a SELECT against tenant_llm_credentials, including the
    // `model` column) doesn't fail with "no such table"/"no such column" for a tenant with no key.
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

  afterEach(() => vi.unstubAllGlobals());

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, prompt: "hello", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns generated text on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "hello world", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(typeof body.text).toBe("string");
  });

  it("returns 400 for missing required fields", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999 }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when provider is openai/anthropic with no configured credentials", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "hello", provider: "openai" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/skills/:id/refresh", () => {
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };

  beforeEach(async () => {
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS skill_content_cache (
         skill_id TEXT PRIMARY KEY,
         content TEXT NOT NULL,
         source_url TEXT NOT NULL,
         fetched_at TEXT NOT NULL
       )`
    ).run();
    await env.CONTENT_DB.prepare("DELETE FROM skill_content_cache").run();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/skills/marketingskills-social/refresh", { method: "POST" }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("fetches and caches the skill content on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Latest guide", { status: 200 })));

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/skills/marketingskills-social/refresh", {
        method: "POST",
        headers: { "X-Internal-Secret": "test-internal-secret" },
      }),
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const row = await env.CONTENT_DB.prepare("SELECT content FROM skill_content_cache WHERE skill_id = ?")
      .bind("marketingskills-social").first<{ content: string }>();
    expect(row?.content).toBe("# Latest guide");
  });

  it("returns 502 for an unknown skill id", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/skills/not-a-real-skill/refresh", {
        method: "POST",
        headers: { "X-Internal-Secret": "test-internal-secret" },
      }),
      testEnv
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /internal/generate-image", () => {
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
    AI: { run: async () => ({ image: btoa("fake-jpeg-bytes") }) } as unknown as Ai,
  };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, prompt: "a lizard", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("stores the generated image in R2 and returns its public URL on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "a lizard", provider: "default" }),
      }),
      { ...testEnv, CONTENT_URL: "https://content-dev.uni-scrm.com" }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ url: string }>();
    expect(body.url).toMatch(/^https:\/\/content-dev\.uni-scrm\.com\/public\/media\/[0-9a-f-]+$/);

    const key = body.url.split("/").pop()!;
    const stored = await env.MEDIA_BUCKET.get(key);
    expect(stored).toBeTruthy();
    expect(stored!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).toBe("fake-jpeg-bytes");
  });

  it("returns 502 when provider: 'openai' has no configured credentials", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "a lizard", provider: "openai" }),
      }),
      testEnv
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /internal/detect-face", () => {
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
  };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns hasFace: true when the model detects a face", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => ({ objects: [{ x: 1 }] }) } as unknown as Ai }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ hasFace: boolean }>();
    expect(body.hasFace).toBe(true);
  });

  it("returns hasFace: false when the model detects no face", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => ({ objects: [] }) } as unknown as Ai }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ hasFace: boolean }>();
    expect(body.hasFace).toBe(false);
  });

  it("returns 400 when imageUrl is missing", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 502 when the model call throws", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => { throw new Error("model down"); } } as unknown as Ai }
    );
    expect(res.status).toBe(502);
  });
});
