import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

const tenantDataDbRunMock = vi.fn().mockResolvedValue({ changes: 1 });

vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query() { return Promise.resolve([]); }
    run(...args: unknown[]) { return tenantDataDbRunMock(...args); }
  },
}));

function mockWebDb(d1DatabaseId: string | null) {
  return { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null),
  }) }) };
}

function mockLinkDb(channelRow: { config: string; channel_type: string; tenant_id: number } | null) {
  return { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(channelRow),
  }) }) };
}

const testSecret = "test-internal-secret";
const testEnv = { ...env, INTERNAL_SECRET: testSecret };

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
    tenantDataDbRunMock.mockClear();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/v2/post/publish/inbox/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const publishCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/v2/post/publish/inbox/video/init/"));
    const publishBody = JSON.parse(publishCall![1].body as string);
    expect(publishBody).toEqual({ source_info: { source: "PULL_FROM_URL", video_url: baseBody.videoUrl } });
    expect(tenantDataDbRunMock).toHaveBeenCalledTimes(1);
    const [insertSql, insertParams] = tenantDataDbRunMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO content/);
    expect(insertParams[3]).toBe("VIDEO_POST");
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
      { ...testEnv, LINK_DB: mockLinkDb({ ...channelRow, channel_type: "X" }), WEB_DB: mockWebDb("tenant-db-1") }
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
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    const body = await res.json() as { ok: boolean; rateLimited?: boolean };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    vi.unstubAllGlobals();
  });
});
