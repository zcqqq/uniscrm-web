import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchVideoListPageMock = vi.fn();
const upsertContentFromMetadataMock = vi.fn();

vi.mock("../../../src/services/tiktok-content-api", () => ({
  fetchVideoListPage: (...args: unknown[]) => fetchVideoListPageMock(...args),
}));

vi.mock("../../../src/services/content", () => ({
  ContentService: class {
    upsertContentFromMetadata(...args: unknown[]) {
      return upsertContentFromMetadataMock(...args);
    }
  },
}));

import { runTikTokContentPoller } from "../../../src/services/pollers/tiktok-content";

function createMockLinkDb(pollState: Record<string, unknown> | null) {
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(pollState),
      run,
    }),
  }));
  return { prepare, run };
}

describe("runTikTokContentPoller", () => {
  beforeEach(() => {
    fetchVideoListPageMock.mockReset();
    upsertContentFromMetadataMock.mockReset().mockResolvedValue(true);
  });

  it("does nothing when channel_poll_state has no seeded row", async () => {
    const linkDb = createMockLinkDb(null);

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).not.toHaveBeenCalled();
  });

  it("backfill: pages via cursor until has_more is false, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    fetchVideoListPageMock
      .mockResolvedValueOnce({ page: { data: [{ id: "v1" }], nextCursor: 10, hasMore: true }, rateLimited: false })
      .mockResolvedValueOnce({ page: { data: [{ id: "v2" }], nextCursor: undefined, hasMore: false }, rateLimited: false });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).toHaveBeenCalledTimes(2);
    expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(2);
    const completeCall = linkDb.run.mock.calls.find((c: unknown[]) => true);
    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("backfill_complete = 1"))).toBe(true);
  });

  it("incremental: stops after a page produces zero new videos", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-01-01T00:00:00Z" });
    upsertContentFromMetadataMock.mockResolvedValue(false);
    fetchVideoListPageMock.mockResolvedValueOnce({
      page: { data: [{ id: "v1" }, { id: "v2" }], nextCursor: 5, hasMore: true },
      rateLimited: false,
    });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).toHaveBeenCalledTimes(1);
    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("last_polled_at = datetime"))).toBe(true);
  });

  it("stops backfill without setting backfill_complete when rate limited", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    fetchVideoListPageMock.mockResolvedValueOnce({ page: { data: [], hasMore: false }, rateLimited: true });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("backfill_complete = 1"))).toBe(false);
  });
});
