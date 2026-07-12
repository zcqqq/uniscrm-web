import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPostsPoller } from "../../src/services/pollers/x-posts";

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
    query: vi.fn().mockResolvedValue([]), // every tweet is "new" by default
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

describe("runPostsPoller", () => {
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
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "world" }], meta: {} }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tenantDb.run).toHaveBeenCalledTimes(2); // one INSERT per tweet
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb, { deadline: Date.now() - 1 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets content_type=ARTICLE when the tweet has an article structure, TWEET otherwise", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          { id: "t1", text: "plain tweet" },
          { id: "t2", text: "https://t.co/x", article: { title: "Free Skill - some article" } },
        ],
        meta: {},
      })
    );

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    const inserts = tenantDb.run.mock.calls;
    const tweetInsert = inserts.find((c: unknown[]) => (c[1] as unknown[]).includes("t1"));
    const articleInsert = inserts.find((c: unknown[]) => (c[1] as unknown[]).includes("t2"));
    expect(tweetInsert![1]).toContain("TWEET");
    expect(articleInsert![1]).toContain("ARTICLE");
    expect(articleInsert![1]).toContain("Free Skill - some article");
  });

  it("post-backfill: stops after a page with zero new tweets", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    tenantDb.query
      .mockResolvedValueOnce([]) // page 1, tweet "t1" is new
      .mockResolvedValueOnce([{ id: "existing" }]); // page 2, tweet "t2" already known

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "b" }], meta: { next_token: "p3" } }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
