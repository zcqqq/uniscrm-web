import { describe, it, expect, vi, beforeEach } from "vitest";

const pollChannelOnceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/services/pollers/poll-channel", () => ({
  pollChannelOnce: (...args: unknown[]) => pollChannelOnceMock(...args),
}));

import { handlePolling } from "../../src/cron";

describe("handlePolling channel selection", () => {
  beforeEach(() => {
    pollChannelOnceMock.mockClear().mockResolvedValue(undefined);
  });

  it("queries both X and TIKTOK active channels and delegates each to pollChannelOnce", async () => {
    const channelRows = [
      { id: "chan-x", channel_type: "X" },
      { id: "chan-tt", channel_type: "TIKTOK" },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handlePolling(env);

    const call = linkDb.prepare.mock.calls[0][0] as string;
    expect(call).toContain("channel_type IN ('X', 'TIKTOK')");
    expect(call).not.toContain("YOUTUBE_ACCOUNT");
    expect(call).toContain("is_active = 1");

    expect(pollChannelOnceMock).toHaveBeenCalledTimes(2);
    expect(pollChannelOnceMock).toHaveBeenCalledWith(env, "X", "chan-x");
    expect(pollChannelOnceMock).toHaveBeenCalledWith(env, "TIKTOK", "chan-tt");
  });

  it("stops calling pollChannelOnce once the total budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    pollChannelOnceMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(55_000);
    });

    const channelRows = [
      { id: "chan-1", channel_type: "X" },
      { id: "chan-2", channel_type: "X" },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handlePolling(env);

    expect(pollChannelOnceMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("continues polling later channels after one channel's pollChannelOnce throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // handlePolling makes an unrelated fetch to FLOW_URL/internal/list-watches after the
    // polling loop; stub it so this test doesn't add its own copy of the pre-existing
    // "Invalid URL: undefined/internal/list-watches" unhandled-rejection warning.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ watches: [] }), { status: 200 })
    );

    pollChannelOnceMock.mockImplementationOnce(async () => {
      throw new Error("X poll failed");
    });

    const channelRows = [
      { id: "chan-x-fails", channel_type: "X" },
      { id: "chan-x-after", channel_type: "X" },
      { id: "chan-tt-after", channel_type: "TIKTOK" },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb, FLOW_URL: "https://flow.test", INTERNAL_SECRET: "secret" } as any;

    await handlePolling(env);

    expect(pollChannelOnceMock).toHaveBeenCalledTimes(3);
    expect(pollChannelOnceMock).toHaveBeenNthCalledWith(1, env, "X", "chan-x-fails");
    expect(pollChannelOnceMock).toHaveBeenNthCalledWith(2, env, "X", "chan-x-after");
    expect(pollChannelOnceMock).toHaveBeenNthCalledWith(3, env, "TIKTOK", "chan-tt-after");

    const loggedError = consoleErrorSpy.mock.calls
      .map((call) => call[0])
      .find((arg) => typeof arg === "string" && arg.includes("poll_channel_error"));
    expect(loggedError).toBeDefined();
    expect(loggedError).toContain("chan-x-fails");

    consoleErrorSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
