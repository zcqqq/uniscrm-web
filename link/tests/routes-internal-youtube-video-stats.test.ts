import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { internalRoutes, boundedYouTubeReason } from "../src/routes-internal";
import type { Env } from "../src/types";

// videos.list 的最小真实响应形状——字段路径必须和 metadata/youtube.ts 的 dataId 对得上，
// 否则这个测试会假绿（props 里什么都没有也算"成功"）。用真的 Response 而不是手搓假对象，
// 与 link/tests/oauth-youtube.test.ts 的既有写法一致。
function videosListResponse(item: Record<string, unknown> | null) {
  return new Response(JSON.stringify({ items: item ? [item] : [] }), { status: 200 });
}

const SAMPLE_ITEM = {
  id: "vid123",
  snippet: {
    publishedAt: "2026-07-01T00:00:00Z",
    title: "How I built it",
    description: "a description",
    thumbnails: { default: { url: "https://i.ytimg.com/vi/vid123/default.jpg" } },
  },
  contentDetails: { duration: "PT3M20S" },
  statistics: { viewCount: "12000", likeCount: "800" },
};

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/internal", internalRoutes());
  return (body: unknown) =>
    a.fetch(
      new Request("https://link.test/internal/youtube/video-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { YOUTUBE_API_KEY: "test-key" } as unknown as Env
    );
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /internal/youtube/video-stats", () => {
  it("returns props mapped by the YouTube content metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => videosListResponse(SAMPLE_ITEM)));
    const res = await app()({ videoId: "vid123" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.props.source_content_id).toBe("vid123");
    expect(body.props.title).toBe("How I built it");
    expect(body.props.view_count).toBe("12000");
    expect(body.props.like_count).toBe("800");
    // ISO8601 → 秒，证明走了 parseISO8601Duration 而不是把原串透传
    expect(body.props.duration).toBe(200);
    expect(body.props.content_url).toBe("https://www.youtube.com/watch?v=vid123");
  });

  it("reports video_unavailable when videos.list returns no item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => videosListResponse(null)));
    const res = await app()({ videoId: "gone" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason.startsWith("video_unavailable")).toBe(true);
  });

  it("reports youtube_api_error when the API call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason.startsWith("youtube_api_error")).toBe(true);
  });

  it("keeps the API error body out of reason — flow writes reason into content_flow_log", async () => {
    // fetchVideoDetails 抛的消息里带着 Google 的完整错误体，长度不可控。
    const hugeBody = JSON.stringify({ error: { message: "x".repeat(5000) } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(hugeBody, { status: 500 })));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.reason).toBe("youtube_api_error: videos.list HTTP 500");
    expect(body.reason).not.toContain("xxx");
  });

  it("distinguishes quota exhaustion (403) — this node never retries, so reason is the only trace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { reason: "quotaExceeded" } }), { status: 403 })
    ));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("youtube_quota_exceeded: videos.list HTTP 403");
  });

  it("falls back to a fixed string when no HTTP status can be extracted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("youtube_api_error: request failed");
  });

  it("leaves duration unset rather than faking 0 when it cannot be parsed", async () => {
    // "P0D" = 直播/待发布，没有已知时长。填 0 会让下游条件判定得出假结论。
    vi.stubGlobal("fetch", vi.fn(async () =>
      videosListResponse({ ...SAMPLE_ITEM, contentDetails: { duration: "P0D" } })
    ));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect("duration" in body.props).toBe(false);
  });

  it("rejects a missing videoId with the same { ok, reason } shape as every other outcome", async () => {
    const res = await app()({});
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("video_unavailable: no videoId in payload");
  });
});

function channelsListResponse(item: Record<string, unknown> | null) {
  return new Response(JSON.stringify({ items: item ? [item] : [] }), { status: 200 });
}

const SAMPLE_CHANNEL = {
  id: "UC123",
  snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t.jpg" } } },
  statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
};

// SAMPLE_ITEM 的 snippet 原本没有 channelId（作者频道 id 之前没人用）。
const ITEM_WITH_CHANNEL = { ...SAMPLE_ITEM, snippet: { ...SAMPLE_ITEM.snippet, channelId: "UC123" } };

// 一个 stub 同时服务两个端点：按 URL 分流，比按调用次序分流稳——次序一变测试就假绿。
function twoEndpointFetch(channelsResponder: () => Response) {
  return vi.fn(async (input: any) =>
    String(input).includes("/channels") ? channelsResponder() : videosListResponse(ITEM_WITH_CHANNEL)
  );
}

describe("POST /internal/youtube/video-stats — withAuthor", () => {
  it("withAuthor 缺省时不调用 channels.list", async () => {
    const f = vi.fn(async () => videosListResponse(ITEM_WITH_CHANNEL));
    vi.stubGlobal("fetch", f);
    const body = await (await app()({ videoId: "vid123" })).json() as { ok: boolean; props: Record<string, unknown> };
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain("/videos");
    expect(Object.keys(body.props).some((k) => k.startsWith("user."))).toBe(false);
  });

  it("withAuthor=true 时返回合并后的 props，两个 view_count 各是各的", async () => {
    vi.stubGlobal("fetch", twoEndpointFetch(() => channelsListResponse(SAMPLE_CHANNEL)));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.props.view_count).toBe("12000");                 // 这个视频的播放量
    expect(body.props["user.view_count"]).toBe("5000000000");    // 频道历史总播放量
    expect(body.props["user.followers_count"]).toBe("1000000");
  });

  it("channels.list 返回空 items → ok:false, reason channel_unavailable", async () => {
    // 频道已删/已封。与 video_unavailable 对称：绝不用缺失的作者数据去猜 true/false。
    vi.stubGlobal("fetch", twoEndpointFetch(() => channelsListResponse(null)));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json();
    expect(body).toEqual({ ok: false, reason: "channel_unavailable" });
  });

  it("channels.list HTTP 403 → 有界的 youtube_quota_exceeded，5000 字符错误体不进 reason", async () => {
    // reason 会一路写进 content_flow_log 这张分析表，长度不可控的外部返回体不能入库。
    vi.stubGlobal("fetch", twoEndpointFetch(() => new Response("x".repeat(5000), { status: 403 })));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("youtube_quota_exceeded: channels.list HTTP 403");
    expect(body.reason.length).toBeLessThan(80);
  });
});

describe("boundedYouTubeReason", () => {
  it("按端点名与状态码产出有界字符串", () => {
    expect(boundedYouTubeReason(new Error("YouTube videos.list failed: 403 " + "x".repeat(5000))))
      .toBe("youtube_quota_exceeded: videos.list HTTP 403");
    expect(boundedYouTubeReason(new Error("YouTube channels.list failed: 403 body")))
      .toBe("youtube_quota_exceeded: channels.list HTTP 403");
    expect(boundedYouTubeReason(new Error("YouTube channels.list failed: 500 body")))
      .toBe("youtube_api_error: channels.list HTTP 500");
    expect(boundedYouTubeReason(new Error("something else entirely")))
      .toBe("youtube_api_error: request failed");
  });
});
