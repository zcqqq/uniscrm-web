import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCron } from "../src/cron";
import * as youtubeApi from "../src/services/youtube-api";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("YouTube WebSub renewal cron", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function baseEnv(overrides: Record<string, unknown> = {}) {
    return {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) }) },
      WEB_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) },
      FLOW_URL: "https://flow.example",
      LINK_URL: "https://link.example",
      INTERNAL_SECRET: "secret",
      X_BEARER_TOKEN: "", TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "",
      TREND_RETENTION_DAYS: "30",
      ...overrides,
    } as any;
  }

  it("renews a subscription nearing lease expiry for a still-referenced channel", async () => {
    const nearExpiry = new Date(Date.now() + 60_000).toISOString(); // 1 min from now, well under 24h window
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc", websub_lease_expires_at: nearExpiry }) }] }) };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "chan1" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/chan1"), "UCabc");
  });

  it("does not renew a channel whose lease is not close to expiry", async () => {
    const farExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc", websub_lease_expires_at: farExpiry }) }] }) };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "chan1" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("unsubscribes and deactivates a channel no longer referenced by any published flow", async () => {
    const updateBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc" }) }] }) };
        }
        if (sql.startsWith("UPDATE channels SET is_active")) {
          return { bind: updateBind };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [] }); // no longer referenced
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(unsubscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/chan1"), "UCabc");
    expect(updateBind).toHaveBeenCalledWith("chan1");
  });

  it("does not touch subscriptions when the watches fetch fails", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) }) };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub");
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub");

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return Promise.resolve(new Response(null, { status: 500 }));
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
  });
});
