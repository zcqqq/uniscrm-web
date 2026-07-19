import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestYouTubeVideo } from "../../../src/services/pollers/youtube-content";
import * as youtubeApi from "../../../src/services/youtube-api";

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
});
