import { describe, it, expect, vi, beforeEach } from "vitest";
import { XUnauthorizedError } from "../../../src/services/x-errors";
import { TikTokUnauthorizedError } from "../../../src/services/tiktok-errors";

const runFollowersPollerMock = vi.fn().mockResolvedValue(undefined);
const runPostsPollerMock = vi.fn().mockResolvedValue(undefined);
const runTikTokContentPollerMock = vi.fn().mockResolvedValue(undefined);
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
const getValidTokenMock = vi.fn().mockResolvedValue("tok");
const refreshAccessTokenMock = vi.fn().mockResolvedValue("refreshed-tok");
const tiktokGetValidTokenMock = vi.fn().mockResolvedValue("tt-tok");
const tiktokRefreshAccessTokenMock = vi.fn().mockResolvedValue("tt-refreshed-tok");

vi.mock("../../../src/services/pollers/x-followers", () => ({
  runFollowersPoller: (...args: unknown[]) => runFollowersPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/x-posts", () => ({
  runPostsPoller: (...args: unknown[]) => runPostsPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/tiktok-content", () => ({
  runTikTokContentPoller: (...args: unknown[]) => runTikTokContentPollerMock(...args),
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
vi.mock("../../../../shared/tenant-data-db", () => ({ TenantDataDB: class {} }));

import { pollChannelOnce } from "../../../src/services/pollers/poll-channel";

function baseEnv(linkDb: unknown, webDb: unknown) {
  return {
    LINK_DB: linkDb,
    WEB_DB: webDb,
    CF_ACCOUNT_ID: "acct",
    CF_D1_API_TOKEN: "token",
    TIKTOK_CLIENT_KEY: "tt-key",
    TIKTOK_CLIENT_SECRET: "tt-secret",
    PIPELINE_USER: undefined,
    PIPELINE_CONTENT: undefined,
    AI: {},
    VECTORIZE: {},
  } as any;
}

function mockWebDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ d1_database_id: "tenant-db-id" }) }),
    }),
  };
}

describe("pollChannelOnce", () => {
  beforeEach(() => {
    runFollowersPollerMock.mockClear().mockResolvedValue(undefined);
    runPostsPollerMock.mockClear().mockResolvedValue(undefined);
    runTikTokContentPollerMock.mockClear().mockResolvedValue(undefined);
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
});
