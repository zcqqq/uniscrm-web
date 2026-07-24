import { describe, it, expect, vi, afterEach } from "vitest";
import { initPhotoPost, initVideoPost } from "../../src/services/tiktok-publish";

describe("initPhotoPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls TikTok's photo-post init endpoint with MEDIA_UPLOAD/PULL_FROM_URL and returns ok + publishId on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "pub-123" }, error: { code: "ok", message: "" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a", "https://link-dev.uni-scrm.com/public/media/b"], "My Title", "My description");

    expect(result).toEqual({ ok: true, publishId: "pub-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/content/init/");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { title: "My Title", description: "My description" },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: ["https://link-dev.uni-scrm.com/public/media/a", "https://link-dev.uni-scrm.com/public/media/b"],
        photo_cover_index: 0,
      },
    });
  });

  it("returns rateLimited: true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "too many requests" } }), { status: 429 })
    ));

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a"], "T", "D");

    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok: false for any other error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_params", message: "bad request" } }), { status: 400 })
    ));

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a"], "T", "D");

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^tiktok_api_error(:|$)/) });
  });

  it("returns ok: false when response body is not valid JSON, even with 2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not json", { status: 200 })
    ));

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a"], "T", "D");

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^tiktok_api_error(:|$)/) });
  });
});

describe("initVideoPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls TikTok's inbox video init endpoint with PULL_FROM_URL only (no post_info) and returns ok + publishId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await initVideoPost("access-token-1", "https://content-dev.uni-scrm.com/public/media/vid-key");

    expect(result).toEqual({ ok: true, publishId: "pub-vid-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      source_info: {
        source: "PULL_FROM_URL",
        video_url: "https://content-dev.uni-scrm.com/public/media/vid-key",
      },
    });
  });

  it("returns rateLimited: true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "" } }), { status: 429 })
    ));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4");
    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok: false for any other error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_param", message: "" } }), { status: 400 })
    ));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^tiktok_api_error(:|$)/) });
  });

  it("returns ok: false when response body is not valid JSON, even with 2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^tiktok_api_error(:|$)/) });
  });
});
