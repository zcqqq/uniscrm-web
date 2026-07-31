import { describe, it, expect, vi, beforeEach } from "vitest";
import { XUnauthorizedError } from "../../../src/services/x-errors";
import { TikTokUnauthorizedError } from "../../../src/services/tiktok-errors";

const runFollowersPollerMock = vi.fn().mockResolvedValue(undefined);
const runPostsPollerMock = vi.fn().mockResolvedValue(undefined);
const runTikTokContentPollerMock = vi.fn().mockResolvedValue(undefined);
const runListPostsPollerMock = vi.fn().mockResolvedValue(undefined);
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
const getValidTokenMock = vi.fn().mockResolvedValue("tok");
const refreshAccessTokenMock = vi.fn().mockResolvedValue("refreshed-tok");
const tiktokGetValidTokenMock = vi.fn().mockResolvedValue("tt-tok");
const tiktokRefreshAccessTokenMock = vi.fn().mockResolvedValue("tt-refreshed-tok");

// 粉丝轮询的总开关（x-followers.ts 的 FOLLOWERS_POLLING_ENABLED，生产上是 false）。
// 这里用 getter 暴露成可变值：默认 true，让下面那些「调度/换 token」的用例继续测真实接线，
// 另有一个用例把它翻成 false，验证关掉之后一次 X 调用都不会发生。
let followersPollingEnabled = true;
vi.mock("../../../src/services/pollers/x-followers", () => ({
  runFollowersPoller: (...args: unknown[]) => runFollowersPollerMock(...args),
  get FOLLOWERS_POLLING_ENABLED() { return followersPollingEnabled; },
}));
vi.mock("../../../src/services/pollers/x-posts", () => ({
  runPostsPoller: (...args: unknown[]) => runPostsPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/tiktok-content", () => ({
  runTikTokContentPoller: (...args: unknown[]) => runTikTokContentPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/x-list-posts", () => ({
  runListPostsPoller: (...args: unknown[]) => runListPostsPollerMock(...args),
}));
vi.mock("../../../src/services/app-credentials", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
}));
vi.mock("../../../src/services/x-token", () => ({
  XTokenService: class {
    getValidToken(...args: unknown[]) { return getValidTokenMock(...args); }
    refreshAccessToken(...args: unknown[]) { return refreshAccessTokenMock(...args); }
  },
}));
vi.mock("../../../src/services/tiktok-token", () => ({
  TikTokTokenService: class {
    getValidToken(...args: unknown[]) { return tiktokGetValidTokenMock(...args); }
    refreshAccessToken(...args: unknown[]) { return tiktokRefreshAccessTokenMock(...args); }
  },
}));
import { pollChannelOnce, pollXListPosts } from "../../../src/services/pollers/poll-channel";

// resolveTenantDb (poll-channel.ts) reads tenants.d1_database_id off WEB_DB once per channel,
// before any poller runs — a tenant with no provisioned D1 is skipped entirely, before the
// token service ever makes an external call (2026-07-26 plan, last round's I1 lesson). Every
// poller call in this file is mocked wholesale, so the returned TenantDataDB only needs to be
// truthy for the "provisioned" path; mockWebDb() defaults to that so the existing
// poller-forwarding assertions below don't have to know about this guard. The dedicated
// "no provisioned D1" tests further down override it with mockWebDb(null).
function baseEnv(linkDb: unknown, webDb: unknown) {
  return {
    LINK_DB: linkDb,
    WEB_DB: webDb,
    CF_ACCOUNT_ID: "acct",
    CF_D1_API_TOKEN: "tok",
    TIKTOK_CLIENT_KEY: "tt-key",
    TIKTOK_CLIENT_SECRET: "tt-secret",
    PIPELINE_USER: undefined,
    PIPELINE_CONTENT: undefined,
    AI: {},
    VECTORIZE: {},
  } as any;
}

function mockWebDb(d1DatabaseId: string | null = "tenant-db-1") {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null) }),
    }),
  };
}

describe("pollChannelOnce", () => {
  beforeEach(() => {
    followersPollingEnabled = true;
    runFollowersPollerMock.mockClear().mockResolvedValue(undefined);
    runPostsPollerMock.mockClear().mockResolvedValue(undefined);
    runTikTokContentPollerMock.mockClear().mockResolvedValue(undefined);
    runListPostsPollerMock.mockClear().mockResolvedValue(undefined);
    getAppCredentialsMock.mockClear();
    getValidTokenMock.mockClear().mockResolvedValue("tok");
    refreshAccessTokenMock.mockClear().mockResolvedValue("refreshed-tok");
    tiktokGetValidTokenMock.mockClear().mockResolvedValue("tt-tok");
    tiktokRefreshAccessTokenMock.mockClear().mockResolvedValue("tt-refreshed-tok");
  });

  it("X: skips non-BYOK channels", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "chan-1",
            tenant_id: 1,
            config: JSON.stringify({ is_byok: false, x_user_id: "u1" }),
          }),
        }),
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runFollowersPollerMock).not.toHaveBeenCalled();
    expect(runPostsPollerMock).not.toHaveBeenCalled();
  });

  it("X: BYOK channel with seeded poll state runs both followers and posts", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
  });

  it("X: FOLLOWERS_POLLING_ENABLED=false 时不跑粉丝轮询，posts 不受影响", async () => {
    followersPollingEnabled = false;
    const polledNames: string[] = [];
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        // channel_poll_state 的 poller_name 是绑定参数，不在 SQL 文本里 —— 记 bind 实参
        return {
          bind: vi.fn().mockImplementation((_channelId: string, pollerName: string) => {
            polledNames.push(pollerName);
            return { first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) };
          }),
        };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runFollowersPollerMock).not.toHaveBeenCalled();
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    // 短路要发生在 shouldPoll 之前：关掉之后连 followers 那行的 D1 读都不该发生
    expect(polledNames).toEqual(["posts"]);
  });

  it("X: force-refreshes and retries once on XUnauthorizedError (followers)", async () => {
    runFollowersPollerMock
      .mockRejectedValueOnce(new XUnauthorizedError("expired"))
      .mockResolvedValueOnce(undefined);
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("chan-1");
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(2);
    expect(runFollowersPollerMock.mock.calls[0][0]).toMatchObject({ accessToken: "tok" });
    expect(runFollowersPollerMock.mock.calls[1][0]).toMatchObject({ accessToken: "refreshed-tok" });
    // posts still runs independently on the original (unrefreshed at call time) token
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
  });

  it("TIKTOK: no BYOK gate — runs content poller for any active channel with seeded poll state", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-tt", tenant_id: 1, config: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "TIKTOK", "chan-tt");
    expect(runTikTokContentPollerMock).toHaveBeenCalledTimes(1);
    expect(runTikTokContentPollerMock.mock.calls[0][0]).toMatchObject({ channelId: "chan-tt", accessToken: "tt-tok" });
  });

  it("TIKTOK: force-refreshes and retries once on TikTokUnauthorizedError", async () => {
    runTikTokContentPollerMock
      .mockRejectedValueOnce(new TikTokUnauthorizedError("expired"))
      .mockResolvedValueOnce(undefined);
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-tt", tenant_id: 1, config: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "TIKTOK", "chan-tt");
    expect(tiktokRefreshAccessTokenMock).toHaveBeenCalledWith("chan-tt");
    expect(runTikTokContentPollerMock).toHaveBeenCalledTimes(2);
  });

  it("X: still runs the posts poller when the followers poller throws a non-401 error (failure isolation)", async () => {
    runFollowersPollerMock.mockRejectedValueOnce(new Error("X get-followers failed: 503 Service Unavailable"));
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await expect(pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1")).resolves.not.toThrow();
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
  });

  it("X: gives the posts poller its own fresh budget even if followers consumed most of it (starvation fix)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    runFollowersPollerMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(15_000);
    });
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    const postsDeadline = runPostsPollerMock.mock.calls[0][0].deadline as number;
    // Each poller computes its own deadline fresh (Date.now() + 20s) rather than
    // being capped by a shared run-level deadline, so posts still gets ~20s here.
    expect(postsDeadline - Date.now()).toBeGreaterThan(15_000);
    vi.useRealTimers();
  });

  it("X: skips entirely (no token fetched, no poller run) when the tenant has no provisioned D1 database", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }),
        }),
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb(null)), "X", "chan-1");
    // The guard runs before the token service — burning a refresh for a tenant that can't
    // persist anything would be exactly last round's I1 lesson.
    expect(getAppCredentialsMock).not.toHaveBeenCalled();
    expect(getValidTokenMock).not.toHaveBeenCalled();
    expect(runFollowersPollerMock).not.toHaveBeenCalled();
    expect(runPostsPollerMock).not.toHaveBeenCalled();
  });

  it("TIKTOK: skips entirely (no token fetched, no poller run) when the tenant has no provisioned D1 database", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "chan-tt", tenant_id: 1, config: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }),
        }),
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb(null)), "TIKTOK", "chan-tt");
    expect(tiktokGetValidTokenMock).not.toHaveBeenCalled();
    expect(runTikTokContentPollerMock).not.toHaveBeenCalled();
  });
});

describe("pollXListPosts", () => {
  beforeEach(() => {
    runListPostsPollerMock.mockClear().mockResolvedValue(undefined);
    getAppCredentialsMock.mockClear();
    getValidTokenMock.mockClear().mockResolvedValue("tok");
  });

  it("no-ops when the channel is not found", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    await pollXListPosts(baseEnv(linkDb, mockWebDb()), "chan1", "listA");
    expect(runListPostsPollerMock).not.toHaveBeenCalled();
  });

  it("no-ops when the channel is not BYOK-active", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
        id: "chan1", tenant_id: 1, config: JSON.stringify({ is_byok: false, x_user_id: "xu1" }),
      }) }) }),
    };
    await pollXListPosts(baseEnv(linkDb, mockWebDb()), "chan1", "listA");
    expect(runListPostsPollerMock).not.toHaveBeenCalled();
  });

  it("find-or-creates the channel_poll_state row for 'list_posts:{listId}', then calls runListPostsPoller with the channel's token", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "xu1" }),
          }) }) };
        }
        if (sql.includes("INSERT OR IGNORE INTO channel_poll_state")) {
          return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }) }) };
        }
        // shouldPoll's SELECT FROM channel_poll_state — no prior last_polled_at, always allowed through
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };

    await pollXListPosts(baseEnv(linkDb, mockWebDb()), "chan1", "listA");

    const insertIgnoreCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT OR IGNORE INTO channel_poll_state"));
    expect(insertIgnoreCall).toBeTruthy();
    expect(runListPostsPollerMock).toHaveBeenCalledWith(expect.objectContaining({ channelId: "chan1", listId: "listA", accessToken: "tok" }));
  });

  it("skips polling when shouldPoll's repoll gate says too recent, but the poll_state row was still seeded", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "xu1" }),
          }) }) };
        }
        if (sql.includes("INSERT OR IGNORE INTO channel_poll_state")) {
          return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 1, last_polled_at: new Date().toISOString() }) }) };
      }),
    };

    await pollXListPosts(baseEnv(linkDb, mockWebDb()), "chan1", "listA");

    expect(runListPostsPollerMock).not.toHaveBeenCalled();
  });

  it("force-refreshes and retries once on XUnauthorizedError", async () => {
    runListPostsPollerMock
      .mockRejectedValueOnce(new XUnauthorizedError("expired"))
      .mockResolvedValueOnce(undefined);
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "xu1" }),
          }) }) };
        }
        if (sql.includes("INSERT OR IGNORE INTO channel_poll_state")) {
          return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };

    await pollXListPosts(baseEnv(linkDb, mockWebDb()), "chan1", "listA");

    expect(refreshAccessTokenMock).toHaveBeenCalledWith("chan1");
    expect(runListPostsPollerMock).toHaveBeenCalledTimes(2);
    expect(runListPostsPollerMock.mock.calls[1][0]).toMatchObject({ accessToken: "refreshed-tok" });
  });

  it("skips entirely (no token fetched, no poller run) when the tenant has no provisioned D1 database", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "xu1" }),
          }) }) };
        }
        if (sql.includes("INSERT OR IGNORE INTO channel_poll_state")) {
          return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };

    await pollXListPosts(baseEnv(linkDb, mockWebDb(null)), "chan1", "listA");

    expect(getValidTokenMock).not.toHaveBeenCalled();
    expect(runListPostsPollerMock).not.toHaveBeenCalled();
  });
});
