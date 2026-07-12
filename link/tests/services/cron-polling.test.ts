import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { XUnauthorizedError } from "../../src/services/x-errors";

const runFollowersPollerMock = vi.fn().mockResolvedValue(undefined);
const runPostsPollerMock = vi.fn().mockResolvedValue(undefined);
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
const getValidTokenMock = vi.fn().mockResolvedValue("tok");
const refreshAccessTokenMock = vi.fn().mockResolvedValue("refreshed-tok");

vi.mock("../../src/services/pollers/x-followers", () => ({
  runFollowersPoller: (...args: unknown[]) => runFollowersPollerMock(...args),
}));

vi.mock("../../src/services/pollers/x-posts", () => ({
  runPostsPoller: (...args: unknown[]) => runPostsPollerMock(...args),
}));

vi.mock("../../src/services/app-credentials", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
}));

vi.mock("../../src/services/x-token", () => ({
  XTokenService: class {
    getValidToken(...args: unknown[]) {
      return getValidTokenMock(...args);
    }
    refreshAccessToken(...args: unknown[]) {
      return refreshAccessTokenMock(...args);
    }
  },
}));

vi.mock("../../src/services/x-webhook", () => ({
  XActivityService: class {},
}));

vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {},
}));

import { handlePolling } from "../../src/cron";

// Two channel rows: one is BYOK only via config.is_byok (DB column absent/0), the other
// has config.is_byok falsy. Only the first should reach runFollowersPoller.
function createMockLinkDb() {
  const channelRows = [
    {
      id: "chan-byok-config",
      tenant_id: 1,
      config: JSON.stringify({ is_byok: true, x_user_id: "xuser-1" }),
    },
    {
      id: "chan-not-byok",
      tenant_id: 2,
      config: JSON.stringify({ is_byok: false, x_user_id: "xuser-2" }),
    },
  ];

  const pollStateRow = { backfill_complete: 0, last_polled_at: null };

  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM channels")) {
      return {
        all: vi.fn().mockResolvedValue({ results: channelRows }),
      };
    }
    if (sql.includes("channel_poll_state")) {
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(pollStateRow),
        }),
      };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });

  return { prepare };
}

function createMockWebDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ d1_database_id: "tenant-db-id" }),
      }),
    }),
  };
}

describe("handlePolling channel selection", () => {
  beforeEach(() => {
    runFollowersPollerMock.mockClear();
    runPostsPollerMock.mockClear();
    getAppCredentialsMock.mockClear();
    getValidTokenMock.mockClear();
    refreshAccessTokenMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only polls channels that are BYOK per config.is_byok, not the DB is_byok column", async () => {
    const linkDb = createMockLinkDb();
    const webDb = createMockWebDb();

    const env = {
      LINK_DB: linkDb as unknown as D1Database,
      WEB_DB: webDb as unknown as D1Database,
      CF_ACCOUNT_ID: "acct",
      CF_D1_API_TOKEN: "token",
      PIPELINE_USER: undefined,
    } as any;

    await handlePolling(env);

    // The query itself must not filter on the DB column is_byok.
    const channelsCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("FROM channels"));
    expect(channelsCall![0]).not.toMatch(/is_byok\s*=\s*1/);

    // Only the config.is_byok=true channel should reach the poller.
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(1);
    expect(runFollowersPollerMock.mock.calls[0][0]).toMatchObject({
      channelId: "chan-byok-config",
      xUserId: "xuser-1",
    });

    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock.mock.calls[0][0]).toMatchObject({
      channelId: "chan-byok-config",
      xUserId: "xuser-1",
    });
  });

  it("still runs the posts poller when the followers poller throws (independent failure isolation)", async () => {
    runFollowersPollerMock.mockRejectedValueOnce(new Error("X get-followers failed: 503 Service Unavailable"));

    const linkDb = createMockLinkDb();
    const webDb = createMockWebDb();

    const env = {
      LINK_DB: linkDb as unknown as D1Database,
      WEB_DB: webDb as unknown as D1Database,
      CF_ACCOUNT_ID: "acct",
      CF_D1_API_TOKEN: "token",
      PIPELINE_USER: undefined,
    } as any;

    await expect(handlePolling(env)).resolves.not.toThrow();

    expect(runFollowersPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock.mock.calls[0][0]).toMatchObject({
      channelId: "chan-byok-config",
      xUserId: "xuser-1",
    });
  });

  it("force-refreshes the token and retries once when a poller throws XUnauthorizedError", async () => {
    runFollowersPollerMock
      .mockRejectedValueOnce(new XUnauthorizedError("X get-followers failed: 401 Unauthorized"))
      .mockResolvedValueOnce(undefined);

    const linkDb = createMockLinkDb();
    const webDb = createMockWebDb();

    const env = {
      LINK_DB: linkDb as unknown as D1Database,
      WEB_DB: webDb as unknown as D1Database,
      CF_ACCOUNT_ID: "acct",
      CF_D1_API_TOKEN: "token",
      PIPELINE_USER: undefined,
    } as any;

    await expect(handlePolling(env)).resolves.not.toThrow();

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("chan-byok-config");
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(2);
    expect(runFollowersPollerMock.mock.calls[0][0]).toMatchObject({ accessToken: "tok" });
    expect(runFollowersPollerMock.mock.calls[1][0]).toMatchObject({ accessToken: "refreshed-tok" });
  });

  it("gives the posts poller its own fresh budget even if followers consumed most of the tick (starvation fix)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    // Simulate a long-running followers backfill that eats nearly the whole
    // 50s TOTAL_BUDGET_MS before posts even starts.
    runFollowersPollerMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(45_000);
    });

    const linkDb = createMockLinkDb();
    const webDb = createMockWebDb();
    const env = {
      LINK_DB: linkDb as unknown as D1Database,
      WEB_DB: webDb as unknown as D1Database,
      CF_ACCOUNT_ID: "acct",
      CF_D1_API_TOKEN: "token",
      PIPELINE_USER: undefined,
    } as any;

    await handlePolling(env);

    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    const postsDeadline = runPostsPollerMock.mock.calls[0][0].deadline as number;
    // Under the old shared-runDeadline logic, posts would get at most ~5s
    // (runDeadline - elapsed). The fix grants a fresh ~20s PER_CHANNEL_BUDGET_MS.
    expect(postsDeadline - Date.now()).toBeGreaterThan(15_000);
  });
});
