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

// XUsersService's first constructor argument is now the per-tenant D1 (TenantDataDB) — the
// source of truth for `user` (2026-07-26 plan). runFollowersPoller forwards whatever it is
// handed as `ctx.entityState` straight into `new XUsersService(...)`'s first slot, so until
// task 7 rewires the poller's context this stand-in has to be D1-shaped. Whether a follower
// counts as "new" — what upsertPage tallies, and what stops the incremental poll — is now
// decided by the D1 probe, not by an entity_state claim.
function createMockTenantDb(existingBySourceId: Record<string, Record<string, unknown>> = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO user")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      const prior = existingBySourceId[String(row.source_user_id)];
      return [{
        id: prior ? prior.id : row.id,
        created_at: prior ? prior.created_at : row.created_at,
        is_follow: row.is_follow ?? prior?.is_follow ?? 0,
        is_followed: row.is_followed ?? prior?.is_followed ?? 0,
      }];
    }
    const prior = existingBySourceId[String(params[1])];
    return prior ? [prior] : [];
  });
  return { query, run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };
}

// A follower already stored in D1 — the probe finds it, so upsertUserFromMetadata returns false.
function knownFollower(sourceUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `stored-${sourceUserId}`,
    created_at: "2026-07-01T00:00:00.000Z",
    is_follow: 0,
    is_followed: 1,
    name: null, username: null, verified_type: null, profile_image_url: null, description: null,
    followers_count: null, following_count: null, post_count: null,
    listed_count: null, like_count: null, media_count: null,
    ...overrides,
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
      linkDb: linkDb as any, entityState: tenantDb as any, tenantId: 1,
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
      linkDb: linkDb as any, entityState: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // one D1 upsert per follower
    const upserts = tenantDb.query.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO user"));
    expect(upserts).toHaveLength(2);
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
      linkDb: linkDb as any, entityState: tenantDb as any, tenantId: 1,
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
      linkDb: linkDb as any, entityState: tenantDb as any, tenantId: 1,
      deadline: Date.now() - 1, // already past
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("post-backfill: stops after a page with zero new users", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    // page 1: follower "1" is new (absent from D1); page 2: follower "2" is already stored
    const tenantDb = createMockTenantDb({ "2": knownFollower("2") });

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: { next_token: "p3" } }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    // stops after page 2 (zero new users there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
