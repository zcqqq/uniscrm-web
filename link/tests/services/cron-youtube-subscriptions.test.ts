import { describe, it, expect, vi, beforeEach } from "vitest";

const pollYouTubeChannelMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/services/pollers/poll-channel", () => ({
  pollYouTubeChannel: (...args: unknown[]) => pollYouTubeChannelMock(...args),
}));

import { handleYouTubeSubscriptions } from "../../src/cron";

describe("handleYouTubeSubscriptions", () => {
  beforeEach(() => {
    pollYouTubeChannelMock.mockClear().mockResolvedValue(undefined);
  });

  it("queries active YOUTUBE_ACCOUNT channels and polls each of them", async () => {
    const channelRows = [
      { id: "acct-1", config: "{}", tenant_id: 1 },
      { id: "acct-2", config: "{}", tenant_id: 2 },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handleYouTubeSubscriptions(env);

    const call = linkDb.prepare.mock.calls[0][0] as string;
    expect(call).toContain("YOUTUBE_ACCOUNT");
    expect(call).toContain("is_active = 1");

    expect(pollYouTubeChannelMock).toHaveBeenCalledTimes(2);
    expect(pollYouTubeChannelMock).toHaveBeenCalledWith(env, channelRows[0]);
    expect(pollYouTubeChannelMock).toHaveBeenCalledWith(env, channelRows[1]);
  });

  it("stops once its own budget is exhausted, without touching handlePolling's 50s budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    pollYouTubeChannelMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(25_000);
    });

    const channelRows = [
      { id: "acct-1", config: "{}", tenant_id: 1 },
      { id: "acct-2", config: "{}", tenant_id: 2 },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handleYouTubeSubscriptions(env);

    expect(pollYouTubeChannelMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // This is the regression test for the bug this handler was split out to fix: a single
  // account's failure must not abort the loop and starve every account queued behind it.
  it("continues polling later accounts after one account's pollYouTubeChannel throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pollYouTubeChannelMock.mockImplementationOnce(async () => {
      throw new Error("youtube sync failed");
    });

    const channelRows = [
      { id: "acct-fails", config: "{}", tenant_id: 1 },
      { id: "acct-after-1", config: "{}", tenant_id: 2 },
      { id: "acct-after-2", config: "{}", tenant_id: 3 },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handleYouTubeSubscriptions(env);

    expect(pollYouTubeChannelMock).toHaveBeenCalledTimes(3);
    expect(pollYouTubeChannelMock).toHaveBeenNthCalledWith(1, env, channelRows[0]);
    expect(pollYouTubeChannelMock).toHaveBeenNthCalledWith(2, env, channelRows[1]);
    expect(pollYouTubeChannelMock).toHaveBeenNthCalledWith(3, env, channelRows[2]);

    const loggedError = consoleErrorSpy.mock.calls
      .map((call) => call[0])
      .find((arg) => typeof arg === "string" && arg.includes("youtube_subscriptions_channel_error"));
    expect(loggedError).toBeDefined();
    expect(loggedError).toContain("acct-fails");

    consoleErrorSpy.mockRestore();
  });
});
