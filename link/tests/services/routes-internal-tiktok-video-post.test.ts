import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

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
// guard, before any external call. Defaults to "provisioned".
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

const testSecret = "test-internal-secret";
const testEnv = { ...env, INTERNAL_SECRET: testSecret, WEB_DB: mockWebDb() };

describe("POST /internal/tiktok/video-post", () => {
  const baseBody = {
    contentId: "content-vid-1", channelId: "tiktok-chan-1",
    prompts: { title: "Write a catchy title", description: "Write a caption" },
    textProvider: "none" as const,
    videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-key-1",
    flowId: "flow-1",
  };
  const channelRow = { config: JSON.stringify({ access_token: "tok-1" }), channel_type: "TIKTOK", tenant_id: 1 };

  it("uploads the video to the creator's inbox and records content on success", async () => {
    const pipelineContent = mockPipelineContent();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/v2/post/publish/inbox/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const publishCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/v2/post/publish/inbox/video/init/"));
    const publishBody = JSON.parse(publishCall![1].body as string);
    expect(publishBody).toEqual({ source_info: { source: "PULL_FROM_URL", video_url: baseBody.videoUrl } });
    // recordPublishedContent wrote the new content row to R2 via the pipeline.
    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
    const sentRecord = pipelineContent.send.mock.calls[0][0][0];
    expect(sentRecord.content_type).toBe("VIDEO_POST");
    vi.unstubAllGlobals();
  });

  it("returns ok:false for a non-TIKTOK channel without calling TikTok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb({ ...channelRow, channel_type: "X" }), PIPELINE_CONTENT: mockPipelineContent() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^unsupported_channel_type(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns rateLimited:true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "" } }), { status: 429 })
    ));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() }
    );

    const body = await res.json() as { ok: boolean; rateLimited?: boolean };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns tenant_db_not_provisioned (200, not 500) and never generates text when the tenant has no provisioned D1 database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, WEB_DB: mockWebDb(null), LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "tenant_db_not_provisioned" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
