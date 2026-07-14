import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchVideoListPageMock = vi.fn();
const upsertContentFromMetadataMock = vi.fn();
const contentServiceConstructorMock = vi.fn();

vi.mock("../../../src/services/tiktok-content-api", () => ({
  fetchVideoListPage: (...args: unknown[]) => fetchVideoListPageMock(...args),
}));

vi.mock("../../../src/services/content", () => ({
  ContentService: class {
    constructor(...args: unknown[]) {
      contentServiceConstructorMock(...args);
    }
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
    contentServiceConstructorMock.mockReset();
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

  it("converts create_time (Unix epoch seconds) to an ISO8601 source_created_at before upserting", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    fetchVideoListPageMock.mockResolvedValueOnce({
      page: { data: [{ id: "v1", create_time: 1781669273 }], nextCursor: undefined, hasMore: false },
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

    expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(1);
    const resolvedProps = upsertContentFromMetadataMock.mock.calls[0][1];
    expect(resolvedProps.source_created_at).toBe(new Date(1781669273 * 1000).toISOString());
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

  // This file mocks ContentService entirely (see vi.mock above), so the real
  // flowQueue.send() gating inside upsertContentFromMetadata is covered by
  // content.test.ts, not here. What these two tests verify is this poller's own
  // responsibility: that it (a) threads ctx.flowQueue into the ContentService
  // constructor, and (b) forwards the correct emitFlowEvent boolean (backfill=false,
  // incremental=true) as upsertContentFromMetadata's 5th argument.
  describe("tiktok-content poller: content.created emission gating", () => {
    it("passes emitFlowEvent=false to upsertContentFromMetadata during backfill", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      fetchVideoListPageMock.mockResolvedValueOnce({
        page: { data: [{ id: "v1" }], nextCursor: undefined, hasMore: false },
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
        flowQueue: flowQueue as any,
        deadline: Date.now() + 20_000,
      });

      expect(contentServiceConstructorMock.mock.calls[0]).toContain(flowQueue);
      expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(1);
      expect(upsertContentFromMetadataMock.mock.calls[0][4]).toBe(false);
    });

    it("passes emitFlowEvent=true to upsertContentFromMetadata during incremental polling", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-01-01T00:00:00Z" });
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      fetchVideoListPageMock.mockResolvedValueOnce({
        page: { data: [{ id: "v1" }], nextCursor: undefined, hasMore: false },
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
        flowQueue: flowQueue as any,
        deadline: Date.now() + 20_000,
      });

      expect(contentServiceConstructorMock.mock.calls[0]).toContain(flowQueue);
      expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(1);
      expect(upsertContentFromMetadataMock.mock.calls[0][4]).toBe(true);
    });
  });
});
