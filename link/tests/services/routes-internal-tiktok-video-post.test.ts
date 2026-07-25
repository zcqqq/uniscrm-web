import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

// routes-internal.ts writes published content via ContentService.recordPublishedContent,
// which now goes through EntityStateStore (a real D1 write against LINK_DB) and
// PIPELINE_CONTENT.send (R2) — no more TenantDataDB/D1-REST-API detour. mockLinkDb routes by
// SQL text: the channel lookup uses `first`, entity_state bookkeeping uses `run`.
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
    const pipelineContent = mockPipelineContent();
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
});
