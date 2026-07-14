import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchVideoListPage } from "../../src/services/tiktok-content-api";
import { TikTokUnauthorizedError } from "../../src/services/tiktok-errors";

describe("fetchVideoListPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the full field list and passes cursor/max_count in the body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok" } }), { status: 200 })
    );

    await fetchVideoListPage("tok", 42);

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string)).toContain("open.tiktokapis.com/v2/video/list/");
    expect((url as string)).toContain("fields=");
    const calledUrl = new URL(url as string);
    expect(calledUrl.searchParams.get("fields")).toBe(
      "id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count"
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ max_count: 20, cursor: 42 });
  });

  it("omits cursor from the body when not provided", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok" } }), { status: 200 })
    );

    await fetchVideoListPage("tok");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ max_count: 20 });
  });

  it("parses videos, nextCursor, and hasMore from a successful response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { videos: [{ id: "v1", title: "t1" }], cursor: 100, has_more: true }, error: { code: "ok" } }),
        { status: 200 }
      )
    );

    const result = await fetchVideoListPage("tok");

    expect(result.rateLimited).toBe(false);
    expect(result.page.data).toEqual([{ id: "v1", title: "t1" }]);
    expect(result.page.nextCursor).toBe(100);
    expect(result.page.hasMore).toBe(true);
  });

  it("returns rateLimited:true when error.code is rate_limit_exceeded", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "too many requests" } }), { status: 200 })
    );

    const result = await fetchVideoListPage("tok");

    expect(result.rateLimited).toBe(true);
    expect(result.page.data).toEqual([]);
  });

  it("throws TikTokUnauthorizedError when error.code is access_token_invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "access_token_invalid", message: "expired" } }), { status: 200 })
    );

    await expect(fetchVideoListPage("tok")).rejects.toThrow(TikTokUnauthorizedError);
  });

  it("throws a generic error on other failures", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(fetchVideoListPage("tok")).rejects.toThrow("TikTok video.list failed");
  });

  it("throws TikTokUnauthorizedError when a non-2xx status body still carries access_token_invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "access_token_invalid", message: "expired" } }), { status: 401 })
    );

    await expect(fetchVideoListPage("tok")).rejects.toThrow(TikTokUnauthorizedError);
  });
});
