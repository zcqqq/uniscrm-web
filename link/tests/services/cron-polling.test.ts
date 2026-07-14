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
});
