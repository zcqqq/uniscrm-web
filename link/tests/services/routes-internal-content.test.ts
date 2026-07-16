/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const tenantDataDbRunMock = vi.fn().mockResolvedValue({ changes: 1 });

// The real TenantDataDB talks to the Cloudflare D1 REST API over global `fetch`, which
// would collide with this file's `vi.stubGlobal("fetch", ...)` mocks for content-generate
// and the X post call. Mocked here the same way tests/services/pollers/poll-channel.test.ts
// mocks TenantDataDB.
vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query() {
      return Promise.resolve([]);
    }
    run(...args: unknown[]) {
      return tenantDataDbRunMock(...args);
    }
  },
}));

function mockWebDb(d1DatabaseId: string | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null),
      }),
    }),
  };
}

// The handler and XTokenService.getValidToken both `SELECT ... FROM channels WHERE id = ?`
// on different subsets of columns from the same row — one canned row (with every field
// either call might read) satisfies both, same pattern pollers/poll-channel.test.ts uses.
function mockLinkDb(channelRow: { config: string; channel_type: string; tenant_id: number } | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(channelRow),
      }),
    }),
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
    vi.stubGlobal("fetch", fetchMock);

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
    expect(String(url)).toBe("https://api.x.com/2/users/x-user-src-1/repost");
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
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /internal/content/create-post generates, posts to X, and records the new content row", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-999", text: "generated post text" } }), { status: 201 })); // X /2/tweets
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", targetChannelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(tenantDataDbRunMock).toHaveBeenCalledTimes(1); // recordPublishedContent wrote the new content row
    const [insertSql, insertParams] = tenantDataDbRunMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO content/);
    // [id, channelId, channelType, sourceContentId, contentText, status, raw_data, created_at, updated_at]
    expect(insertParams[1]).toBe("tgt-chan"); // target channel id
    expect(insertParams[2]).toBe("X"); // channel_type
    expect(insertParams[3]).toBe("tweet-999"); // source_content_id = new tweet's id
    expect(insertParams[4]).toBe("generated post text"); // content_text
    expect(JSON.parse(insertParams[6] as string)).toEqual({
      generatedFromContentId: "content-1",
      flowId: "flow-1",
    });
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
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-none-1", text: "plain text post" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "plain text post", provider: "none", targetChannelId: "tgt-chan-none" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the X call, no /internal/generate call
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.x.com");
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response (not a bare ok:false) when X createPost is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 })); // X /2/tweets rate-limited
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", targetChannelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    expect(tenantDataDbRunMock).not.toHaveBeenCalled(); // no content row recorded when rate-limited
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the target channel is not X (e.g. TIKTOK)", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "TIKTOK",
      tenant_id: 1,
    };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", targetChannelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled(); // platform check happens before generate/X calls
    expect(tenantDataDbRunMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when generation fails", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("generation error", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "raw prompt text", provider: "default", targetChannelId: "tgt-chan", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // generate only, no X call
    expect(tenantDataDbRunMock).not.toHaveBeenCalled(); // no content row recorded
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
});
