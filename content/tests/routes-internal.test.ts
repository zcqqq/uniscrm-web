/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as generateImageModule from "../src/services/generate-image";
import { SKILL_CATALOG } from "../src/skills/catalog";

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
    // Schema mirrors post-migration tenant_llm_credentials (0003_nullable_api_key_for_default_provider.sql
    // + 0007_image_model.sql): encrypted_api_key nullable (the 'default' provider has none) and
    // image_model present (generate-image's getImageModel/getDefaultImageModel select it below).
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

// 部署后 CI 调的就是这个端点。之所以由服务端遍历 SKILL_CATALOG 而不是 CI 逐个 id 去 curl：
// 往 catalog 里加技能时不该还要记得改两个 workflow —— 忘了改的后果是一份永远为空的缓存，
// 而缓存为空完全静默（照常出文，只是模型没看到技能）。
describe("POST /internal/skills/refresh-all", () => {
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

  const call = () =>
    worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/skills/refresh-all", {
        method: "POST",
        headers: { "X-Internal-Secret": "test-internal-secret" },
      }),
      testEnv
    );

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/skills/refresh-all", { method: "POST" }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("刷新 catalog 里的每一个技能——不是只刷第一个，也不是靠调用方列 id", async () => {
    // 每次调用新建一个 Response：mockResolvedValue 会把同一个实例发给三次 fetch，第二次
    // 读 body 就是 "Body has already been read"，测试会假失败。
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Latest guide", { status: 200 })));

    const res = await call();

    expect(res.status).toBe(200);
    const body = await res.json<{ refreshed: string[]; failed: unknown[] }>();
    expect(body.refreshed.sort()).toEqual(SKILL_CATALOG.map((s) => s.id).sort());
    expect(body.failed).toEqual([]);

    const rows = await env.CONTENT_DB.prepare("SELECT skill_id FROM skill_content_cache").all<{ skill_id: string }>();
    expect(rows.results.map((r) => r.skill_id).sort()).toEqual(SKILL_CATALOG.map((s) => s.id).sort());
  });

  it("一个技能的源挂了不连累其余技能，但整体返回 502 让 CI 那一步变红", async () => {
    const failing = SKILL_CATALOG[0].sourceUrl;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      String(url) === failing ? new Response("nope", { status: 404 }) : new Response("# Latest guide", { status: 200 })
    ));

    const res = await call();

    expect(res.status).toBe(502);
    const body = await res.json<{ refreshed: string[]; failed: { skillId: string }[] }>();
    expect(body.failed.map((f) => f.skillId)).toEqual([SKILL_CATALOG[0].id]);
    // 关键：其余技能仍然被刷新了，没有在第一个失败处停下。
    expect(body.refreshed.sort()).toEqual(SKILL_CATALOG.slice(1).map((s) => s.id).sort());
  });
});

describe("POST /internal/generate-image", () => {
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
    // 两段式出图后 stage 1（文本）和 stage 2（出图）都打在同一个 env.AI.run 上，两种
    // 响应形状都得给到：文本模型读 { response }（见 workers-ai.ts），扩散模型读
    // { image }（见 workers-ai-image.ts）。
    AI: { run: async () => ({ response: "a lizard", image: btoa("fake-jpeg-bytes") }) } as unknown as Ai,
  };

  beforeEach(async () => {
    // stage 1 现在总是带 skillId: "marketingskills-image" 跑一次 generateContent，
    // 它会读 skill_content_cache（技能文档缓存）和 skill_context（租户上下文）——两张表
    // 不在这个 describe 之前的任何 beforeEach 里保证存在，自己建，别依赖执行顺序。
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS skill_content_cache (
         skill_id TEXT PRIMARY KEY,
         content TEXT NOT NULL,
         source_url TEXT NOT NULL,
         fetched_at TEXT NOT NULL
       )`
    ).run();
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS skill_context (
         tenant_id INTEGER NOT NULL, skill_repo TEXT NOT NULL, content TEXT NOT NULL,
         version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, skill_repo))`
    ).run();
  });

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, provider: "default", sourceTitle: "a lizard" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("缺少 sourceTitle 和 sourceText 时 400", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "X-Internal-Secret": "test-internal-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("stores the generated image in R2 and returns its public URL on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, provider: "default", sourceTitle: "a lizard" }),
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

  it("returns 400 (end-to-end, unmocked) when provider: 'openai' has no image model or credentials configured", async () => {
    // Real DB round-trip (no generateImage mock): tenant 999 has zero tenant_llm_credentials
    // rows for 'openai', so getImageModel resolves null before credentials — or stage 1 — are
    // ever touched; this is a config-class failure, not a flaky-model failure, so it's 400
    // (see "returns 400 (not 502)" above, which covers the same branch via a mocked generateImage).
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, provider: "openai", sourceTitle: "a lizard" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 502) when the tenant has no image model for the provider", async () => {
    vi.spyOn(generateImageModule, "generateImage").mockRejectedValue(new Error("No image model configured for provider openai"));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "X-Internal-Secret": "test-internal-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, provider: "openai", sourceTitle: "a lizard" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });
});
