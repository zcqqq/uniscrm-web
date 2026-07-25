import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// routes-internal.ts writes published content via ContentService.recordPublishedContent,
// which now goes through EntityStateStore (a real D1 write against LINK_DB — no D1 REST API
// call, so no fetch collision like the old TenantDataDB did) and PIPELINE_CONTENT.send (R2).
// mockLinkDb routes by SQL text: the channel lookup uses `first`, entity_state bookkeeping
// uses `run` (INSERT OR IGNORE / UPDATE) — same double serves both.
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
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };

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
    vi.stubGlobal("fetch", fetchMock);

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
});
