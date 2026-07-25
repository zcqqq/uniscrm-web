import { describe, it, expect, vi } from "vitest";

// Sibling to tiktok-content.test.ts, which mocks ContentService wholesale (needed for its own
// constructor-arg/emitFlowEvent assertions) and therefore can never see a real pipeline record.
// This file deliberately does NOT mock "../../../src/services/content" — it drives the real
// runTikTokContentPoller entry point against a real ContentService, so a regression that drops
// the consumedPaths argument at tiktok-content.ts's upsertContentFromMetadata call site (task-7
// fix round 2's Important 3 residual finding) shows up as a failing assertion here, not just a
// console.warn. Kept in its own file rather than un-mocking tiktok-content.test.ts in place, per
// the review's "prefer whichever keeps the existing tests intact."
const fetchVideoListPageMock = vi.fn();
vi.mock("../../../src/services/tiktok-content-api", () => ({
  fetchVideoListPage: (...args: unknown[]) => fetchVideoListPageMock(...args),
}));

import { runTikTokContentPoller } from "../../../src/services/pollers/tiktok-content";

function createFakeLinkDb(pollState: Record<string, unknown> | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(pollState),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
  };
}

function createRealishEntityState() {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "tt-uuid-1", isNew: true, unchanged: false }),
    get: vi.fn().mockResolvedValue(null),
    markSeen: vi.fn().mockResolvedValue(true),
    setFollow: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runTikTokContentPoller — real ContentService, raw_data stripping (task-7 fix round 2)", () => {
  it("threads consumedPaths into upsertContentFromMetadata so raw_data strips mapped payload fields, keeping unmapped ones", async () => {
    fetchVideoListPageMock.mockReset().mockResolvedValueOnce({
      page: {
        data: [{
          id: "v1",
          video_description: "a video",
          share_url: "https://tiktok.example/share/v1",
          like_count: 10,
          comment_count: 2,
          share_count: 1,
          view_count: 100,
          duration: 30,
          height: 1920,
          width: 1080,
          title: "A Title",
          create_time: 1781669273,
          weird_unmapped_field: "survives",
        }],
        nextCursor: undefined,
        hasMore: false,
      },
      rateLimited: false,
    });

    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const linkDb = createFakeLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      entityState: createRealishEntityState() as any,
      tenantId: 1,
      ai: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) } as any,
      vectorize: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() } as any,
      pipelineContent: pipelineContent as any,
      deadline: Date.now() + 20_000,
    });

    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
    const [[record]] = pipelineContent.send.mock.calls[0];
    // Minor 3 (fix round 1): content_url (share_url) now lands in the source_url column.
    expect(record.source_url).toBe("https://tiktok.example/share/v1");

    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("id"); // source_content_id, column-mapped -> stripped
    expect(raw).not.toHaveProperty("video_description"); // content_text, column-mapped -> stripped
    expect(raw).not.toHaveProperty("share_url"); // content_url -> source_url, column-mapped -> stripped
    expect(raw.weird_unmapped_field).toBe("survives"); // never mapped -> must still be there
  });
});
