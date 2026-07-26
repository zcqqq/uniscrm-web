import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// routes-internal.ts writes published content via ContentService.recordPublishedContent,
// against per-tenant D1 — the source of truth again (2026-07-26 plan, task 7). mockLinkDb
// routes by SQL text: the channel lookup uses `first`.
function mockLinkDb(channelRow: { config: string; channel_type: string; tenant_id: number } | null) {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(sql.includes("FROM channels") ? channelRow : null),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      }),
    })),
  };
}

function mockPipelineContent() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

// routes-internal.ts reads tenants.d1_database_id off WEB_DB right after the tenant_not_set
// guard, before any external call. Defaults to "provisioned" since every test below except the
// dedicated guard test exercises something past it.
function mockWebDb(d1DatabaseId: string | null = "tenant-db-1") {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null) }),
    }),
  };
}

// ContentService's tenantDb (TenantDataDB) talks to the real Cloudflare D1 REST API via
// fetch() — see routes-internal-content.test.ts's identical helper for the full rationale.
const D1_API_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\//;
function withFakeD1(businessFetch: (...args: unknown[]) => unknown) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (D1_API_RE.test(url)) {
      const body = JSON.parse((init?.body as string) || "{}") as { sql: string; params?: unknown[] };
      const { sql, params = [] } = body;
      let results: Record<string, unknown>[] = [];
      if (/^\s*INSERT/i.test(sql)) {
        const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        results = [{ id: row.id, created_at: row.created_at }];
      }
      return new Response(
        JSON.stringify({ success: true, result: [{ results, success: true, meta: { changes: results.length } }] }),
        { status: 200 }
      );
    }
    return (businessFetch as (...a: unknown[]) => unknown)(input, init);
  });
}


const baseBody = {
  contentId: "content-1",
  channelId: "tiktok-chan-1",
  prompts: { title: "Write a catchy title", description: "Write a caption", message_image: "a cyberpunk lizard" },
  textProvider: "none" as const,
  imageCount: 2,
  imageProvider: "default" as const,
  flowId: "flow-1",
};

const channelRow = { config: JSON.stringify({ access_token: "tok-1" }), channel_type: "TIKTOK", tenant_id: 1 };

describe("POST /internal/tiktok/photo-post", () => {
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret", WEB_DB: mockWebDb() };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("generates images, forwards content's URLs, and publishes on success (best-effort: 1 of 2 images failing still succeeds)", async () => {
    const pipelineContent = mockPipelineContent();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/internal/generate-image")) {
        // First call succeeds, second call fails -- best-effort should still publish with 1 image.
        const priorCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("generate-image")).length;
        if (priorCalls === 1) {
          return new Response(JSON.stringify({ url: "https://content-dev.uni-scrm.com/public/media/fake-key-1" }), { status: 200 });
        }
        return new Response("upstream error", { status: 502 });
      }
      if (url.includes("/v2/post/publish/content/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: pipelineContent } as any
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const publishCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/v2/post/publish/content/init/"));
    const publishBody = JSON.parse(publishCall![1].body);
    expect(publishBody.source_info.photo_images).toEqual(["https://content-dev.uni-scrm.com/public/media/fake-key-1"]);
    expect(publishBody.post_info.title).toBe("Write a catchy title"); // textProvider: "none" -> literal prompt text
    // recordPublishedContent wrote the new content row to R2 via the pipeline.
    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
    expect(pipelineContent.send.mock.calls[0][0][0]).toMatchObject({ content_type: "PHOTO_POST", channel_type: "TIKTOK" });
    vi.unstubAllGlobals();
  });

  it("fails without calling TikTok when all image generations fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream error", { status: 502 })));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() } as any
    );

    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  // Task-7 fix round 1, Important 1 — second site (see routes-internal-content.test.ts's
  // create-post test for the full rationale): channels.tenant_id is nullable even though
  // `first<{tenant_id: number}>()` lies about it.
  it("returns ok:false without publishing when the channel has no tenant_id (Important 1)", async () => {
    const noTenantChannelRow = { config: JSON.stringify({ access_token: "tok-1" }), channel_type: "TIKTOK", tenant_id: null } as any;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(noTenantChannelRow), PIPELINE_CONTENT: mockPipelineContent() } as any
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^tenant_not_set(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled(); // never reaches image generation
    vi.unstubAllGlobals();
  });

  it("returns tenant_db_not_provisioned (200, not 500) and never generates images when the tenant has no provisioned D1 database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, WEB_DB: mockWebDb(null), LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() } as any
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "tenant_db_not_provisioned" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
