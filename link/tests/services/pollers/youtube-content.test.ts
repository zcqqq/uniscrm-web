import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestYouTubeVideo } from "../../../src/services/pollers/youtube-content";
import * as youtubeApi from "../../../src/services/youtube-api";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

// 阈值从 metadata 取，改 metadata/youtube.ts 里的 value 时测试自动跟随，不用同步改这里。
const DURATION_LIMIT = Number(
  ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!
    .contentPropsFilter!.find((f) => f.propId === "duration")!.value
);

function createMockTenantDb() {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function baseCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountChannelId: "chan-acc",
    subscriptionChannelId: "chan-sub",
    tenantDb: createMockTenantDb() as any,
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
    expect((ctx.tenantDb as any).run).not.toHaveBeenCalled();
  });

  it("records a genuinely new video into content_trigger_dedup keyed by accountChannelId/subscriptionChannelId", async () => {
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

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid1");

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall).toBeTruthy();
    expect(dedupCall![0]).toContain("INSERT OR IGNORE INTO content_trigger_dedup");
    expect(dedupCall![1]).toEqual(["chan-acc", "chan-sub", "vid1", 1, expect.any(String)]);
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

  it("does not emit content.created when the video was already seen (dedup insert reports changes: 0)", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid4",
      snippet: { title: "Dup", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT1M" },
    });

    const tenantDb = createMockTenantDb();
    tenantDb.run.mockResolvedValue({ changes: 0 });
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ tenantDb, flowQueue });
    await ingestYouTubeVideo(ctx, "vid4");

    expect(flowQueue.send).not.toHaveBeenCalled();
  });

  it("does not emit content.created when duration exceeds the metadata limit, but still records dedup seen", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-long",
      snippet: { title: "Long", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: `PT${DURATION_LIMIT + 1}S` },
    });

    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const logSpy = vi.spyOn(console, "log");
    const ctx = baseCtx({ tenantDb, flowQueue });
    await ingestYouTubeVideo(ctx, "vid-long");

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall).toBeTruthy();
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

    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const logSpy = vi.spyOn(console, "log");
    const ctx = baseCtx({ tenantDb, flowQueue });
    await ingestYouTubeVideo(ctx, "vid-live");

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall).toBeTruthy();
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
