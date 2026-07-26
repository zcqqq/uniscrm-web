import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runListPostsPoller } from "../../../src/services/pollers/x-list-posts";

function createMockLinkDb(initialState: { cursor: string | null; backfill_complete: number; last_polled_at: string | null } | null) {
  const state = { ...initialState } as any;
  const first = vi.fn().mockImplementation(() => Promise.resolve(state ? { ...state } : null));
  const run = vi.fn().mockImplementation(() => Promise.resolve({ success: true }));
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _state: state, _run: run, _bind: bind };
}

// ContentService isn't mocked in this file — it exercises the real content.ts, whose
// recordTriggerContentSeen delegates straight to entityState.markSeen (see entity-state.ts).
// The old D1-era assertions inspected `tenantDb.run`'s raw INSERT OR IGNORE INTO
// content_trigger_dedup SQL; that table is gone, replaced by the entity_state row markSeen
// writes, so assertions now inspect markSeen's call args instead.
function createMockEntityState() {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "uuid-default", isNew: true, unchanged: false }),
    get: vi.fn().mockResolvedValue(null),
    markSeen: vi.fn().mockResolvedValue(true), // true = newly seen (not seen before)
    setFollow: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

describe("runListPostsPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  function baseCtx(linkDb: any, entityState: any, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      channelId: "chan1", listId: "listA", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: null, entityState: entityState as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists for this channel+list", async () => {
    const linkDb = createMockLinkDb(null);
    const entityState = createMockEntityState();
    await runListPostsPoller(baseCtx(linkDb, entityState));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads/writes channel_poll_state under poller_name 'list_posts:listA'", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, entityState));

    const selectCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("SELECT"));
    expect(selectCall[0]).toContain("poller_name = ?");
    const bindCall = linkDb._bind.mock.calls.find((c: unknown[]) => c.includes("list_posts:listA"));
    expect(bindCall).toBeTruthy();
  });

  it("first-ever poll (backfill_complete=0): seeds dedup index from ONE latest-page fetch (no historical pagination), without emitting content.created, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    // next_token present (more historical pages exist) but must NOT be followed — List Posts
    // triggers only care about new content going forward, not a full historical import.
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "existing post" }], meta: { next_token: "p2" } }));

    await runListPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Seed phase still marks the entity_state dedup row (so the next incremental poll doesn't
    // see this backlog as new and flood the flow) — it just never emits.
    expect(entityState.markSeen).toHaveBeenCalledTimes(1);
    expect(entityState.markSeen.mock.calls[0][0]).toMatchObject({ entity: "content_trigger", channelId: "chan1", secondaryId: "listA", sourceId: "t1" });
    expect(flowQueue.send).not.toHaveBeenCalled();

    const updateCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("UPDATE channel_poll_state"));
    expect(updateCall![0]).toContain("backfill_complete = 1");
  });

  it("first-ever poll: rate-limited seed fetch leaves backfill_complete unset so the next cron cycle retries", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 429 })));

    await runListPostsPoller(baseCtx(linkDb, entityState));

    expect(entityState.markSeen).not.toHaveBeenCalled();
    const updateCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("UPDATE channel_poll_state"));
    expect(updateCall).toBeUndefined();
  });

  it("incremental: emits content.created with listId for new list posts", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1", listId: "listA" });
  });

  it("populates content_url as the X status permalink, derived from source_content_id", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "12345", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

    expect(flowQueue.send.mock.calls[0][0].payload).toMatchObject({ content_url: "https://x.com/i/status/12345" });
  });

  it("passes listId as the dedup entity_state row's secondary_id", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, entityState));

    expect(entityState.markSeen).toHaveBeenCalledWith({ entity: "content_trigger", channelId: "chan1", secondaryId: "listA", sourceId: "t1" });
  });
});
