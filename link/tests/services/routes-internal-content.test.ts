/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// Per-tenant D1 is the source of truth again (2026-07-26 plan, task 7: TenantDataDB is back).
// routes-internal.ts reads tenants.d1_database_id off WEB_DB right after the tenant_not_set
// guard, before any external call — a tenant without one gets `{ok:false,
// reason:"tenant_db_not_provisioned"}`. Defaults to "provisioned" since nearly every test below
// exercises something past that guard; the dedicated tests further down pass `null` to prove
// the guard itself.
function mockWebDb(d1DatabaseId: string | null = "tenant-db-1") {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null) }),
    }),
  };
}

function mockPipelineContent() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

// ContentService's tenantDb (TenantDataDB, shared/tenant-data-db.ts) talks to the real
// Cloudflare D1 REST API via fetch() — recordPublishedContent's probe SELECT + `INSERT ...
// RETURNING` upsert now issue two of these per call. Every test below stubs global fetch for
// its OWN business calls (X/TikTok/content-worker), so this wraps that stub: any request to the
// CF D1 REST endpoint is answered by a tiny in-memory fake (insert echoes back the bound
// id/created_at, mirroring content.test.ts's createMockTenantDb) and is NEVER forwarded to (or
// counted against) the caller's own fetchMock — every existing call-count/call-order assertion
// on `fetchMock` stays about the X/TikTok/content calls only.
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
      // SELECT probes always report "no existing row" (every write is treated as new) — these
      // are integration tests of the ROUTE, not of D1 row-identity edge cases (already covered
      // by content.test.ts).
      return new Response(
        JSON.stringify({ success: true, result: [{ results, success: true, meta: { changes: results.length } }] }),
        { status: 200 }
      );
    }
    return (businessFetch as (...a: unknown[]) => unknown)(input, init);
  });
}

// The handler and XTokenService.getValidToken both `SELECT ... FROM channels WHERE id = ?`
// on different subsets of columns from the same row — one canned row (with every field
// either call might read) satisfies both, same pattern pollers/poll-channel.test.ts uses.
// mockLinkDb now also routes SQL to a generic `run` handler for EntityStateStore's
// entity_state INSERT OR IGNORE / UPDATE (recordPublishedContent's claim()).
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

describe("stub content-flow action endpoints", () => {
  // Override env.INTERNAL_SECRET since vitest-pool-workers doesn't pick up [env.dev.vars]
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };
  const testSecret = "test-internal-secret";

  it("POST /internal/x/repost looks up the channel's X user id and reposts the given tweet", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 })); // X /2/users/:id/repost
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    // X names the resource "retweets", not "repost" — see the comment on repostPost().
    expect(String(url)).toBe("https://api.x.com/2/users/x-user-src-1/retweets");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response when X repost is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }));
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the channel has no X user id", async () => {
    const channelRow = { config: JSON.stringify({ access_token: "tok" }), channel_type: "X", tenant_id: 1 };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^channel_not_authorized(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /internal/x/bookmark looks up the channel's X user id and bookmarks the given tweet", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { bookmarked: true } }), { status: 200 })); // X /2/users/:id/bookmarks
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/bookmark", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.x.com/2/users/x-user-src-1/bookmarks");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response when X bookmark is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }));
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/bookmark", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the channel has no X user id (bookmark)", async () => {
    const channelRow = { config: JSON.stringify({ access_token: "tok" }), channel_type: "X", tenant_id: 1 };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/bookmark", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^channel_not_authorized(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /internal/x/like looks up the channel's X user id and likes the given tweet", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { liked: true } }), { status: 200 })); // X /2/users/:id/likes
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/like", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.x.com/2/users/x-user-src-1/likes");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response when X like is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }));
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/like", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the channel has no X user id (like)", async () => {
    const channelRow = { config: JSON.stringify({ access_token: "tok" }), channel_type: "X", tenant_id: 1 };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/like", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^channel_not_authorized(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post generates, posts to X, and records the new content row", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    const pipelineContent = mockPipelineContent();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-999", text: "generated post text" } }), { status: 201 })); // X /2/tweets
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", channelId: "tgt-chan", flowId: "flow-1", skillId: "marketingskills-social" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: "tweet-999" });
    const generateCallBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(generateCallBody.skillId).toBe("marketingskills-social"); // forwarded through to content's /internal/generate
    // recordPublishedContent wrote the new content row to R2 via the pipeline.
    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
    const record = pipelineContent.send.mock.calls[0][0][0] as Record<string, unknown>;
    expect(record.channel_id).toBe("tgt-chan"); // target channel id
    expect(record.channel_type).toBe("X");
    expect(record.content_type).toBe("TWEET"); // content_type (default value)
    expect(record.source_content_id).toBe("tweet-999"); // source_content_id = new tweet's id
    expect(record.content_text).toBe("generated post text");
    expect(JSON.parse(record.raw_data as string)).toEqual({
      generatedFromContentId: "content-1",
      flowId: "flow-1",
    });
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post returns tenant_db_not_provisioned (200, not 500) and never posts to X when the tenant has no provisioned D1 database", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", channelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(null) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "tenant_db_not_provisioned" });
    // Guarded before the X post (and before content's /internal/generate) even goes out —
    // wasting either on a tenant that can't record the result would be exactly last round's
    // I1 lesson.
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // NOTE: The brief's original version of this test wrote directly to `env.LINK_DB`/relied on
  // real `env.WEB_DB` (via `cloudflare:test`). Empirically, this repo's link/vitest.config.ts
  // passes `configPath`/`environment` as flat WorkersPoolOptions keys instead of nesting them
  // under `wrangler: {...}` (the schema `@cloudflare/vitest-pool-workers` v0.18 actually expects
  // — confirmed by reading node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.d.mts).
  // As a result wrangler.toml bindings are never wired into `env` from "cloudflare:test" here:
  // `env.LINK_DB` is `undefined` (only internal __VITEST_POOL_WORKERS_* services are present).
  // Separately, even if that were fixed, WEB_DB has no `migrations_dir`/`tenants` table in this
  // repo's test setup, so the real-D1 tenant lookup would still fail. Using this file's existing
  // mockLinkDb/mockWebDb override pattern (as every other test here does) instead achieves the
  // same assertion — provider:"none" makes exactly one fetch call (the X post, not /internal/generate).
  it("posts the interpolated prompt as-is when provider is 'none', without calling content's /internal/generate", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-none", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-none-1", text: "plain text post" } }), { status: 201 }));
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "plain text post", provider: "none", channelId: "tgt-chan-none" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "tweet-none-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the X call, no /internal/generate call
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.x.com");
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post with videoUrl under 50MB uploads to X and posts with media_ids when processing succeeds immediately", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

    const videoBytes = new Uint8Array(1024); // tiny, well under 50MB
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-1") {
        return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length), "Content-Type": "video/mp4" } });
      }
      if (u === "https://api.x.com/2/media/upload/initialize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-1/finalize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 }); // no processing_info -> succeeded
      }
      if (u === "https://api.x.com/2/media/upload/media-1/append" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ data: { id: "tweet-vid-1", text: "caption text" } }), { status: 201 });
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-1", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-1",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: "tweet-vid-1" });

    const tweetCall = fetchMock.mock.calls.find(([u]: [string]) => u === "https://api.x.com/2/tweets");
    const tweetBody = JSON.parse(tweetCall![1].body as string);
    expect(tweetBody).toEqual({ text: "caption text", media: { media_ids: ["media-1"] } });
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post with videoUrl returns pending:true when X reports processing still in progress", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

    const videoBytes = new Uint8Array(1024);
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-2") {
        return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length) } });
      }
      if (u === "https://api.x.com/2/media/upload/initialize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-2" } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-2/finalize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-2", processing_info: { state: "pending", check_after_secs: 5 } } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-2/append" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-2", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-2",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pending: true, mediaId: "media-2", channelId: "tgt-chan", text: "caption text", checkAfterSecs: 5 });
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post returns ok:false (not pending) when X FINALIZE reports processing state 'failed'", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

    const videoBytes = new Uint8Array(1024);
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-failed") {
        return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length) } });
      }
      if (u === "https://api.x.com/2/media/upload/initialize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-failed-1" } }), { status: 200 });
      }
      // X's real API reports the video processing itself failed, not just an HTTP error.
      if (u === "https://api.x.com/2/media/upload/media-failed-1/finalize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-failed-1", processing_info: { state: "failed" } } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-failed-1/append" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-failed", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-failed",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Terminal "failed" must NOT be reported as pending:true, or the flow worker would poll a
    // media upload that will never succeed (endless/dead polling loop).
    expect(body).toEqual({ ok: false, reason: expect.stringMatching(/^video_upload_failed(:|$)/) });
    expect(fetchMock.mock.calls.some(([u]: [string]) => String(u) === "https://api.x.com/2/tweets")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post chunks a video body larger than 5MB into multiple sequential APPEND calls", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

    const videoBytes = new Uint8Array(12 * 1024 * 1024); // spans 2 full 5MB chunks + a 2MB remainder
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-chunk") {
        return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length), "Content-Type": "video/mp4" } });
      }
      if (u === "https://api.x.com/2/media/upload/initialize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-chunk-1" } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-chunk-1/finalize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-chunk-1" } }), { status: 200 }); // no processing_info -> succeeded
      }
      if (u === "https://api.x.com/2/media/upload/media-chunk-1/append" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ data: { id: "tweet-chunk-1", text: "caption text" } }), { status: 201 });
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-chunk", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-chunk",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: "tweet-chunk-1" });

    const appendCalls = fetchMock.mock.calls.filter(
      ([u]: [string, RequestInit]) => String(u) === "https://api.x.com/2/media/upload/media-chunk-1/append"
    ) as [string, RequestInit][];
    // 12MB / 5MB-per-chunk => 3 APPEND calls (5MB, 5MB, 2MB remainder) proves real chunking,
    // not one giant blob.
    expect(appendCalls.length).toBeGreaterThan(1);
    let totalAppended = 0;
    appendCalls.forEach(([, init], idx) => {
      const form = init.body as FormData;
      expect(Number(form.get("segment_index"))).toBe(idx); // sequential, 0-based
      const media = form.get("media") as Blob;
      expect(media.size).toBeLessThanOrEqual(5 * 1024 * 1024);
      totalAppended += media.size;
    });
    expect(totalAppended).toBe(12 * 1024 * 1024);
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post rejects a video whose streamed body exceeds 50MB even with no Content-Length header (running byte-count guard)", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
    const pipelineContent = mockPipelineContent();

    const chunkBytes = 6 * 1024 * 1024;
    const totalChunks = 9; // 54MB total, well over the 50MB cap
    const makeOversizeStream = (): ReadableStream<Uint8Array> => {
      let sent = 0;
      return new ReadableStream({
        pull(controller) {
          if (sent >= totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkBytes));
          sent++;
        },
      });
    };

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-oversize") {
        // A ReadableStream body carries no Content-Length header, so this exercises the
        // running totalRead byte-count guard in the streaming loop, not the header short-circuit.
        return new Response(makeOversizeStream(), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/initialize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-oversize-1" } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-oversize-1/finalize" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "media-oversize-1" } }), { status: 200 });
      }
      if (u === "https://api.x.com/2/media/upload/media-oversize-1/append" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-oversize", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-oversize",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^video_upload_failed(:|$)/) });

    // Proves this hit the running-byte-count guard, not the Content-Length header guard: INIT
    // (and therefore at least one APPEND) must have fired, since the header guard would have
    // returned before ever calling initMediaUpload.
    const initCalled = fetchMock.mock.calls.some(
      ([u]: [string, RequestInit]) => String(u) === "https://api.x.com/2/media/upload/initialize"
    );
    expect(initCalled).toBe(true);
    // The abort happens mid-stream, before finalize.
    const finalizeCalled = fetchMock.mock.calls.some(
      ([u]: [string, RequestInit]) => String(u) === "https://api.x.com/2/media/upload/media-oversize-1/finalize"
    );
    expect(finalizeCalled).toBe(false);
    expect(pipelineContent.send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post rejects a videoUrl reporting over 50MB via Content-Length without uploading anything to X", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
      if (u === "https://content-dev.uni-scrm.com/public/media/vid-big") {
        return new Response(new Uint8Array(0), { status: 200, headers: { "Content-Length": String(60 * 1024 * 1024) } });
      }
      throw new Error(`Unexpected fetch to X: ${u}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({
          contentId: "content-vid-big", interpolatedPrompt: "raw prompt", provider: "default",
          channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
          videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-big",
        }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: expect.stringMatching(/^video_upload_failed(:|$)/) });
    expect(fetchMock.mock.calls.some(([u]: [string]) => String(u).includes("api.x.com"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response (not a bare ok:false) when X createPost is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    const pipelineContent = mockPipelineContent();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 })); // X /2/tweets rate-limited
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", channelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    expect(pipelineContent.send).not.toHaveBeenCalled(); // no content row recorded when rate-limited
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the target channel is not X (e.g. TIKTOK)", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "TIKTOK",
      tenant_id: 1,
    };
    const pipelineContent = mockPipelineContent();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", channelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^unsupported_channel_type(:|$)/) });
    expect(fetchMock).not.toHaveBeenCalled(); // platform check happens before generate/X calls
    expect(pipelineContent.send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Task-7 fix round 1, Important 1: channels.tenant_id is nullable in the schema even though
  // `first<{tenant_id: number}>()` types it as non-nullable — a legacy or system-level channel
  // row can have no tenant. The old `tenants.d1_database_id` lookup this route used to do
  // incidentally guarded this (binding a null tenant_id matched no row, returning a graceful
  // ok:false). Without an explicit guard, EntityStateStore would construct with a null
  // tenant_id, the tweet would already be posted to X by the time claim()'s INSERT OR IGNORE
  // hits entity_state's NOT NULL constraint, and the route would 500 with an unparseable body.
  it("returns ok:false without posting to X when the channel has no tenant_id (Important 1)", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: null,
    } as any;
    const pipelineContent = mockPipelineContent();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "none", channelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^tenant_not_set(:|$)/) });
    // The guard must fire before the tweet is posted, not after — an uncaught throw further
    // down (inside EntityStateStore.claim) would happen AFTER createPost already succeeded.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pipelineContent.send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when generation fails", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    const pipelineContent = mockPipelineContent();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("generation error", { status: 502 }));
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", channelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^text_generation_failed(:|$)/) });
    expect(fetchMock).toHaveBeenCalledTimes(1); // generate only, no X call
    expect(pipelineContent.send).not.toHaveBeenCalled(); // no content row recorded
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post returns channel_not_authorized instead of a 500 when the token refresh fails", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: "rt", expires_at: new Date(Date.now() - 1000).toISOString() }),
      channel_type: "X",
      tenant_id: 1,
    };
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(channelRow),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oauth unavailable", { status: 503 })));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "literal text", provider: "none", channelId: "tgt-chan", flowId: "flow-1", skillId: "none" }),
      }),
      { ...testEnv, LINK_DB: linkDb, WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^channel_not_authorized(:|$)/) });
    vi.unstubAllGlobals();
  });

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "chan-1", contentId: "content-1" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  describe("POST /internal/content/x-video-status", () => {
    it("posts the tweet and records content when status is succeeded", async () => {
      const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
      const pipelineContent = mockPipelineContent();

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("command=STATUS")) return new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "succeeded" } } }), { status: 200 });
        if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ data: { id: "tweet-status-1", text: "caption text" } }), { status: 201 });
        throw new Error(`Unexpected fetch: ${u}`);
      });
      vi.stubGlobal("fetch", withFakeD1(fetchMock));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb(), PIPELINE_CONTENT: pipelineContent }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: "tweet-status-1" });
      expect(pipelineContent.send).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it("returns pending:true with checkAfterSecs when status is still processing", async () => {
      const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "in_progress", check_after_secs: 10 } } }), { status: 200 })
      ));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pending: true, checkAfterSecs: 10 });
      vi.unstubAllGlobals();
    });

    it("returns ok:false when status is failed", async () => {
      const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "failed" } } }), { status: 200 })
      ));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^video_upload_failed(:|$)/) });
      vi.unstubAllGlobals();
    });

    it("returns rateLimited:true when the final post after processing is rate-limited", async () => {
      const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("command=STATUS")) return new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "succeeded" } } }), { status: 200 });
        if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 });
        throw new Error(`Unexpected fetch: ${u}`);
      });
      vi.stubGlobal("fetch", withFakeD1(fetchMock));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      // A 429 on the final post is transient — reporting it as a plain failure would send the
      // flow down the failed branch permanently, violating "Rate limit重试耗尽后才走failed分支".
      expect(body.ok).toBe(false);
      expect(body.rateLimited).toBe(true);
      expect(typeof body.rateLimitReset).toBe("string");
      vi.unstubAllGlobals();
    });

    it("returns channel_not_authorized instead of a 500 when the token refresh fails", async () => {
      // Expired token forces getValidToken -> refreshAccessToken; the refresh call fails.
      const channelRow = {
        config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: "rt", expires_at: new Date(Date.now() - 1000).toISOString() }),
        channel_type: "X",
        tenant_id: 1,
      };
      const linkDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(channelRow),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oauth unavailable", { status: 503 })));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: linkDb, WEB_DB: mockWebDb("tenant-db-1") }
      );

      // An uncaught throw here becomes a 500 whose body isn't JSON — the flow worker then
      // records a failed branch with NO failure_reason, which is exactly the "null reason"
      // failure this test pins down.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: expect.stringMatching(/^channel_not_authorized(:|$)/) });
      vi.unstubAllGlobals();
    });

    it("returns ok:false (not pending) when status is an unrecognized future state", async () => {
      const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "unknown_future_state" } } }), { status: 200 })
      ));

      const res = await worker.fetch(
        new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
          body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
        }),
        { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      // Unrecognized state must NOT be reported as pending:true, or the flow worker would poll
      // a media upload in an unknown state, causing an endless polling loop.
      expect(body).toEqual({ ok: false, reason: expect.stringMatching(/^video_upload_failed(:|$)/) });
      vi.unstubAllGlobals();
    });
  });
});
