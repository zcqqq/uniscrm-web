import { describe, it, expect, vi, afterEach } from "vitest";
import { syncYouTubeSubscriptions, findOrCreateWatchedChannel } from "../../src/services/youtube-account";
import * as youtubeApi from "../../src/services/youtube-api";

function createMockLinkDb(overrides: { selectResult?: unknown; existingRow?: unknown } = {}) {
  const runMock = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(overrides.existingRow ?? null),
    run: runMock,
  });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _run: runMock, _bind: bind };
}

describe("syncYouTubeSubscriptions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches subscriptions and marks sync_status done", async () => {
    vi.spyOn(youtubeApi, "fetchAllSubscriptions").mockResolvedValue([
      { channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" },
    ]);
    const linkDb = createMockLinkDb({
      existingRow: { config: JSON.stringify({ google_user_id: "g1", email: "a@b.com", sync_status: "pending", subscriptions: [] }) },
    });
    const env = { LINK_DB: linkDb } as any;

    await syncYouTubeSubscriptions(env, "chan1", "access-tok");

    const updateCall = linkDb._bind.mock.calls.find((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("Channel A"));
    expect(updateCall).toBeTruthy();
    const savedConfig = JSON.parse(updateCall![0] as string);
    expect(savedConfig.sync_status).toBe("done");
    expect(savedConfig.subscriptions).toEqual([{ channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" }]);
    expect(savedConfig.last_synced_at).toBeTruthy();
  });

  it("marks sync_status error and does not throw when the API call fails", async () => {
    vi.spyOn(youtubeApi, "fetchAllSubscriptions").mockRejectedValue(new Error("quota exceeded"));
    const linkDb = createMockLinkDb({
      existingRow: { config: JSON.stringify({ google_user_id: "g1", email: "a@b.com", sync_status: "pending", subscriptions: [] }) },
    });
    const env = { LINK_DB: linkDb } as any;

    await expect(syncYouTubeSubscriptions(env, "chan1", "access-tok")).resolves.toBeUndefined();

    const updateCall = linkDb._bind.mock.calls.find((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("error"));
    expect(updateCall).toBeTruthy();
  });

  it("does nothing when the channel row no longer exists", async () => {
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb } as any;
    const spy = vi.spyOn(youtubeApi, "fetchAllSubscriptions");

    await syncYouTubeSubscriptions(env, "gone", "access-tok");

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("findOrCreateWatchedChannel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a new row and subscribes WebSub when none exists", async () => {
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    const result = await findOrCreateWatchedChannel(env, 1, "member1", "UCabc", "Channel A", "https://img/a.jpg");

    expect(result.channelName).toBe("Channel A");
    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/"), "UCabc");
    const insertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO channels"));
    expect(insertCall![0]).toContain("YOUTUBE");
  });

  it("reuses the existing row and does not re-subscribe", async () => {
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: { id: "existing-chan" } });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    const result = await findOrCreateWatchedChannel(env, 1, "member1", "UCabc", "Channel A", "https://img/a.jpg");

    expect(result.channelId).toBe("existing-chan");
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("encodes source_channel_id as tenantId:youtubeChannelId", async () => {
    vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    await findOrCreateWatchedChannel(env, 42, "member1", "UCabc", "Channel A", "");

    const insertBindArgs = linkDb._bind.mock.calls.find((c: unknown[]) => c.includes("42:UCabc"));
    expect(insertBindArgs).toBeTruthy();
  });
});
