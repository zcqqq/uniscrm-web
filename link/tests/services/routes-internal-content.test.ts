/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

let mockContentRow: { title: string | null; content_text: string | null; summary: string | null } | null = {
  title: "Source title",
  content_text: "Source body text",
  summary: "Source summary",
};
const tenantDataDbRunMock = vi.fn().mockResolvedValue({ changes: 1 });

// The real TenantDataDB talks to the Cloudflare D1 REST API over global `fetch`, which
// would collide with this file's `vi.stubGlobal("fetch", ...)` mocks for content-generate
// and the X post call. Mocked here the same way tests/services/pollers/poll-channel.test.ts
// mocks TenantDataDB.
vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query() {
      return Promise.resolve(mockContentRow ? [mockContentRow] : []);
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

  it("POST /internal/x/repost returns 501 not-implemented", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "chan-1", contentId: "content-1" }),
      }),
      testEnv
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, notImplemented: true });
  });

  it("POST /internal/content/ai-rewrite-publish generates, posts to X, and records the new content row", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    mockContentRow = { title: "Source title", content_text: "Source body text", summary: "Source summary" };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-999", text: "generated post text" } }), { status: 201 })); // X /2/tweets
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
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
      skillId: "punchy-social",
    });
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response (not a bare ok:false) when X createPost is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    mockContentRow = { title: "Source title", content_text: "Source body text", summary: "Source summary" };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 })); // X /2/tweets rate-limited
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
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
    mockContentRow = { title: "Source title", content_text: "Source body text", summary: "Source summary" };
    tenantDataDbRunMock.mockClear();

    // Only the content /internal/generate call happens before the platform check runs.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // generate only; api.x.com createPost never called
    const generateCallUrl = (fetchMock.mock.calls[0][0] as string).toString();
    expect(generateCallUrl).toContain("/internal/generate");
    expect(tenantDataDbRunMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling generate or X when the source content row doesn't exist", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    mockContentRow = null; // no row found for contentId
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "missing-content", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled(); // no generate call, no X call
    expect(tenantDataDbRunMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    mockContentRow = { title: "Source title", content_text: "Source body text", summary: "Source summary" }; // restore default for later tests
  });

  it("returns ok:false without calling X when generation fails", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };
    mockContentRow = { title: "Source title", content_text: "Source body text", summary: "Source summary" };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("generation error", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
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
