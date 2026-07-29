import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestYouTubeVideo, fetchYouTubeVideoProps, fetchYouTubeAuthorProps } from "../../../src/services/pollers/youtube-content";
import * as youtubeApi from "../../../src/services/youtube-api";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

// 阈值从 metadata 取，改 metadata/youtube.ts 里的 value 时测试自动跟随，不用同步改这里。
const DURATION_LIMIT = Number(
  ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!
    .contentPropsFilter!.find((f) => f.propId === "duration")!.value
);

// ContentService isn't mocked in this file — it exercises the real content.ts, whose
// recordTriggerContentSeen delegates straight to entityState.markSeen (see entity-state.ts).
// The old D1-era assertions inspected `tenantDb.run`'s raw INSERT OR IGNORE INTO
// content_trigger_dedup SQL and `{changes: N}` results; that table is gone, replaced by the
// entity_state row markSeen writes (boolean return: true = newly seen).
function createMockEntityState() {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "uuid-default", isNew: true, unchanged: false }),
    get: vi.fn().mockResolvedValue(null),
    markSeen: vi.fn().mockResolvedValue(true),
    setFollow: vi.fn().mockResolvedValue(undefined),
  };
}

function baseCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountChannelId: "chan-acc",
    subscriptionChannelId: "chan-sub",
    tenantDb: null,
    entityState: createMockEntityState() as any,
    tenantId: 1,
    ai: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) } as any,
    vectorize: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() } as any,
    apiKey: "key",
    ...overrides,
  };
}

describe("ingestYouTubeVideo", () => {
  // Test isolation: vi.spyOn on the module-level fetchVideoDetails returns the same underlying
  // mock across tests since this file doesn't use vi.mock module factories (unlike
  // tiktok-content.test.ts). Without restoring between tests, call history leaks into later
  // assertions.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when the video no longer exists", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(null);
    const ctx = baseCtx();
    await ingestYouTubeVideo(ctx, "gone-vid");
    expect((ctx.entityState as any).markSeen).not.toHaveBeenCalled();
  });

  it("records a genuinely new video into entity_state keyed by accountChannelId/subscriptionChannelId", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid1",
      snippet: {
        title: "Cool Video",
        description: "desc",
        publishedAt: "2026-07-18T00:00:00Z",
        thumbnails: { default: { url: "https://img/thumb.jpg" } },
      },
      contentDetails: { duration: "PT4M13S" },
      statistics: { viewCount: "100", likeCount: "10" },
    });

    const entityState = createMockEntityState();
    const ctx = baseCtx({ entityState });
    await ingestYouTubeVideo(ctx, "vid1");

    expect(entityState.markSeen).toHaveBeenCalledTimes(1);
    expect(entityState.markSeen.mock.calls[0][0]).toMatchObject({
      entity: "content_trigger", channelId: "chan-acc", secondaryId: "chan-sub", sourceId: "vid1",
    });
  });

  it("emits content.created via flowQueue on a genuinely new video, with subscriptionChannelId and parsed duration", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid3",
      snippet: { title: "New", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT2M" },
    });

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid3");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    expect(flowQueue.send.mock.calls[0][0]).toMatchObject({
      eventType: "content.created",
      channelId: "chan-acc",
      subscriptionChannelId: "chan-sub",
    });
    expect(flowQueue.send.mock.calls[0][0].payload).toMatchObject({ duration: 120 });
  });

  it("populates content_url as the YouTube watch permalink, derived from source_content_id", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid5",
      snippet: { title: "Linked", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT1M" },
    });

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid5");

    expect(flowQueue.send.mock.calls[0][0].payload).toMatchObject({ content_url: "https://www.youtube.com/watch?v=vid5" });
  });

  it("does not emit content.created when the video was already seen (markSeen reports false)", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid4",
      snippet: { title: "Dup", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT1M" },
    });

    const entityState = createMockEntityState();
    entityState.markSeen.mockResolvedValue(false);
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ entityState, flowQueue });
    await ingestYouTubeVideo(ctx, "vid4");

    expect(flowQueue.send).not.toHaveBeenCalled();
  });

  it("does not emit content.created when duration exceeds the metadata limit, but still records dedup seen", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-long",
      snippet: { title: "Long", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: `PT${DURATION_LIMIT + 1}S` },
    });

    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const logSpy = vi.spyOn(console, "log");
    const ctx = baseCtx({ entityState, flowQueue });
    await ingestYouTubeVideo(ctx, "vid-long");

    expect(entityState.markSeen).toHaveBeenCalledTimes(1);
    expect(flowQueue.send).not.toHaveBeenCalled();
    const skipLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("youtube_content_skipped_filter"));
    expect(skipLog).toBeTruthy();
    expect(JSON.parse(skipLog!)).toMatchObject({
      event: "youtube_content_skipped_filter",
      account_channel_id: "chan-acc",
      subscription_channel_id: "chan-sub",
      video_id: "vid-long",
      duration: DURATION_LIMIT + 1,
    });
  });

  it("does not emit content.created for a live/upcoming broadcast (duration P0D unparseable), but still records dedup seen", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-live",
      snippet: { title: "Live", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "P0D" },
    });

    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const logSpy = vi.spyOn(console, "log");
    const ctx = baseCtx({ entityState, flowQueue });
    await ingestYouTubeVideo(ctx, "vid-live");

    expect(entityState.markSeen).toHaveBeenCalledTimes(1);
    expect(flowQueue.send).not.toHaveBeenCalled();
    const skipLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("youtube_content_skipped_filter"));
    expect(skipLog).toBeTruthy();
    expect(JSON.parse(skipLog!)).toMatchObject({
      event: "youtube_content_skipped_filter",
      account_channel_id: "chan-acc",
      subscription_channel_id: "chan-sub",
      video_id: "vid-live",
    });
  });

  it("emits content.created at exactly the metadata limit (boundary inclusive)", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-boundary",
      snippet: { title: "At limit", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: `PT${DURATION_LIMIT}S` },
    });

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid-boundary");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
  });
});

const VIDEO_ITEM = {
  id: "vid1",
  snippet: {
    title: "Cool Video",
    description: "desc",
    publishedAt: "2026-07-18T00:00:00Z",
    channelId: "UC123",
    thumbnails: { default: { url: "https://img/thumb.jpg" } },
  },
  contentDetails: { duration: "PT4M13S" },
  statistics: { viewCount: "100", likeCount: "10" },
};

const CHANNEL_ITEM = {
  id: "UC123",
  snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t.jpg" } } },
  statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
};

describe("fetchYouTubeVideoProps — 作者频道 id", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("从 snippet.channelId 带出 authorChannelId，且不额外发起调用", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    const channelSpy = vi.spyOn(youtubeApi, "fetchChannelDetails");

    const out = await fetchYouTubeVideoProps("key", "vid1");

    expect(out!.authorChannelId).toBe("UC123");
    expect(out!.props.source_content_id).toBe("vid1");
    expect(out!.props.duration).toBe(253);
    expect(channelSpy).not.toHaveBeenCalled();
  });
});

describe("fetchYouTubeAuthorProps", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("channels.list 的 item 映射成 user.* 字段", async () => {
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);
    const props = await fetchYouTubeAuthorProps("key", "UC123");
    expect(props["user.followers_count"]).toBe("1000000");
    expect(props["user.post_count"]).toBe("700");
    expect(props["user.view_count"]).toBe("5000000000");
    expect(props["user.name"]).toBe("Chan");
    // 裸键一个都不能有——否则会覆盖内容侧的同名字段
    expect(Object.keys(props).every((k) => k.startsWith("user."))).toBe(true);
  });

  it("channels.list 返回空时返回 {}（频道已删/已封）", async () => {
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(null);
    expect(await fetchYouTubeAuthorProps("key", "UC123")).toEqual({});
  });

  it("channelId 为空串时直接返回 {} 且不发起请求", async () => {
    const spy = vi.spyOn(youtubeApi, "fetchChannelDetails");
    expect(await fetchYouTubeAuthorProps("key", "")).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("channels.list 出错时向上抛，由调用方决定语义", async () => {
    // ingest 路径吞掉、照常发内容；condition 节点则必须走 failed 分支。
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockRejectedValue(
      new Error("YouTube channels.list failed: 403 quota exceeded")
    );
    await expect(fetchYouTubeAuthorProps("key", "UC123")).rejects.toThrow("channels.list failed: 403");
  });
});

describe("ingestYouTubeVideo — 作者字段", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("作者字段与内容字段一起发给 flow，两个 view_count 各是各的", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ flowQueue }) as any, "vid1");

    const { payload } = flowQueue.send.mock.calls[0][0];
    expect(payload.view_count).toBe("100");                 // 这个视频的播放量
    expect(payload["user.view_count"]).toBe("5000000000");  // 频道历史总播放量
    expect(payload["user.followers_count"]).toBe("1000000");
  });

  // YOUTUBE_API_KEY 是全平台共享的 10000 units/天免费配额。配额烧穿不只是浪费：
  // fetchVideoDetails 一旦抛错，ingest 会在 recordTriggerContentSeen 之前中断，视频没被
  // 记成"见过"，而 WebSub 只推一次——那个视频永久丢失。所以但凡这份 payload 不会发出去，
  // 就一个 unit 都不该花在 channels.list 上。
  it("视频已见过（WebSub 重推）时不打 channels.list", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    const channelSpy = vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);

    const entityState = createMockEntityState();
    entityState.markSeen.mockResolvedValue(false);
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ entityState, flowQueue }) as any, "vid1");

    expect(flowQueue.send).not.toHaveBeenCalled();
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("被 contentPropsFilter 挡掉（超时长）时不打 channels.list", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      ...VIDEO_ITEM,
      id: "vid-long",
      contentDetails: { duration: `PT${DURATION_LIMIT + 1}S` },
    });
    const channelSpy = vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);

    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ entityState, flowQueue }) as any, "vid-long");

    // 去重仍要记（这个视频确实处理过了），只是不为它花作者那 1 unit。
    expect(entityState.markSeen).toHaveBeenCalledTimes(1);
    expect(flowQueue.send).not.toHaveBeenCalled();
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("channels.list 失败时照常发内容，只是不带 user.*", async () => {
    // 整条跳过是错的：recordTriggerContentSeen 已经把它记成"见过"，WebSub 只推一次，
    // 配额恢复也不会补——这个视频会永久丢失。
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockRejectedValue(
      new Error("YouTube channels.list failed: 403 quota exceeded")
    );
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ flowQueue }) as any, "vid1");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    const { payload } = flowQueue.send.mock.calls[0][0];
    expect(payload.view_count).toBe("100");
    expect(Object.keys(payload).some((k) => k.startsWith("user."))).toBe(false);
  });
});
