import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestYouTubeVideo } from "../../../src/services/pollers/youtube-content";
import * as youtubeApi from "../../../src/services/youtube-api";
import * as youtubeVision from "../../../src/services/youtube-vision";

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
    channelId: "chan1",
    tenantDb: createMockTenantDb() as any,
    tenantId: 1,
    ai: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) } as any,
    vectorize: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() } as any,
    apiKey: "key",
    ...overrides,
  };
}

describe("ingestYouTubeVideo", () => {
  // Test isolation: vi.spyOn on module-level functions (fetchVideoDetails, detectFace) returns
  // the same underlying mock across tests since this file doesn't use vi.mock module factories
  // (unlike tiktok-content.test.ts). Without restoring between tests, call history (e.g. from
  // test 2's detectFace call) leaks into later assertions like test 3's "not called" check.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when the video no longer exists", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(null);
    const ctx = baseCtx();
    await ingestYouTubeVideo(ctx, "gone-vid");
    expect((ctx.tenantDb as any).run).not.toHaveBeenCalled();
  });

  it("parses duration, runs face detection on the thumbnail, and upserts content", async () => {
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
    const detectFaceSpy = vi.spyOn(youtubeVision, "detectFace").mockResolvedValue(0);

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid1");

    expect(detectFaceSpy).toHaveBeenCalledWith(ctx.ai, "https://img/thumb.jpg");
    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall).toBeTruthy();
    const insertCols = insertCall![0] as string;
    expect(insertCols).toContain("has_face");
    expect(insertCols).toContain("duration");
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams).toContain(253); // parsed duration
    expect(insertParams).toContain(0); // has_face
  });

  it("defaults has_face to 1 when there is no thumbnail to check", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid2",
      snippet: { title: "No Thumbnail", publishedAt: "2026-07-18T00:00:00Z" },
      contentDetails: { duration: "PT1M" },
    });
    const detectFaceSpy = vi.spyOn(youtubeVision, "detectFace");

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid2");

    expect(detectFaceSpy).not.toHaveBeenCalled();
    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall![1]).toContain(1); // has_face default
  });

  it("emits content.created via flowQueue on a genuinely new video", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid3",
      snippet: { title: "New", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT2M" },
    });
    vi.spyOn(youtubeVision, "detectFace").mockResolvedValue(0);

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid3");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1" });
  });
});
