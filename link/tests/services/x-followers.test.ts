import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFollowersPoller } from "../../src/services/pollers/x-followers";

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
    query: vi.fn().mockResolvedValue([]), // every followed user is "new" by default
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("runFollowersPoller", () => {
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

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: {} }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tenantDb.run).toHaveBeenCalledTimes(2); // one INSERT per follower
    const finalUpdate = linkDb._run.mock.calls.find((c: unknown[]) =>
      (linkDb._bind.mock.calls as unknown[][]).length > 0
    );
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // cursor persisted to "p2" after the first successful page, backfill NOT marked complete
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() - 1, // already past
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("post-backfill: stops after a page with zero new users", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    // first page: one new user; second page: user already exists -> query returns a row
    tenantDb.query
      .mockResolvedValueOnce([]) // page 1, user "1" is new
      .mockResolvedValueOnce([{ id: "existing" }]); // page 2, user "2" already known

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: { next_token: "p3" } }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    // stops after page 2 (zero new users there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
