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

// XUsersService's constructor takes an EntityStateStore, not a TenantDataDB (task-5 converted
// the user write path to R2). runFollowersPoller (x-followers.ts, task-7) forwards whatever
// it's handed as `ctx.entityState` straight into `new XUsersService(ctx.entityState, ...)`.
// `claim`'s isNew controls how many followers upsertPage (x-followers.ts) counts as "new" per
// page.
function createMockEntityState() {
  let seq = 0;
  return {
    claim: vi.fn().mockImplementation(async () => ({ entityId: `uuid-${seq++}`, isNew: true, unchanged: false })),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn().mockResolvedValue(undefined),
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
    const entityState = createMockEntityState();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: {} }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(entityState.claim).toHaveBeenCalledTimes(2); // one claim per follower
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
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
    const entityState = createMockEntityState();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
      deadline: Date.now() - 1, // already past
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("post-backfill: stops after a page with zero new users", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    // page 1: follower "1" is new; page 2: follower "2" already known (isNew: false)
    entityState.claim
      .mockImplementationOnce(async () => ({ entityId: "uuid-0", isNew: true, unchanged: false }))
      .mockImplementationOnce(async () => ({ entityId: "uuid-existing", isNew: false, unchanged: true }));

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: { next_token: "p3" } }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    // stops after page 2 (zero new users there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
