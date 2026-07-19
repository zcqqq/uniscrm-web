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

function createMockTenantDb() {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
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

  function baseCtx(linkDb: any, tenantDb: any, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      channelId: "chan1", listId: "listA", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists for this channel+list", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();
    await runListPostsPoller(baseCtx(linkDb, tenantDb));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads/writes channel_poll_state under poller_name 'list_posts:listA'", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb));

    const selectCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("SELECT"));
    expect(selectCall[0]).toContain("poller_name = ?");
    const bindCall = linkDb._bind.mock.calls.find((c: unknown[]) => c.includes("list_posts:listA"));
    expect(bindCall).toBeTruthy();
  });

  it("first-ever poll (backfill_complete=0): seeds dedup index from ONE latest-page fetch (no historical pagination), without emitting content.created, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    // next_token present (more historical pages exist) but must NOT be followed — List Posts
    // triggers only care about new content going forward, not a full historical import.
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "existing post" }], meta: { next_token: "p2" } }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb, { flowQueue }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Seed phase still records into content_trigger_dedup (so the next incremental poll
    // doesn't see this backlog as new and flood the flow) — it just never emits.
    expect(tenantDb.run).toHaveBeenCalledTimes(1);
    expect(tenantDb.run.mock.calls[0][0]).toContain("INSERT OR IGNORE INTO content_trigger_dedup");
    expect(flowQueue.send).not.toHaveBeenCalled();

    const updateCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("UPDATE channel_poll_state"));
    expect(updateCall![0]).toContain("backfill_complete = 1");
  });

  it("first-ever poll: rate-limited seed fetch leaves backfill_complete unset so the next cron cycle retries", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 429 })));

    await runListPostsPoller(baseCtx(linkDb, tenantDb));

    expect(tenantDb.run).not.toHaveBeenCalled();
    const updateCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("UPDATE channel_poll_state"));
    expect(updateCall).toBeUndefined();
  });

  it("incremental: emits content.created with listId for new list posts", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb, { flowQueue }));

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1", listId: "listA" });
  });

  it("passes listId as the dedup table's secondary_id", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb));

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall![1]).toEqual(["chan1", "listA", "t1", 1, expect.any(String)]);
  });
});
