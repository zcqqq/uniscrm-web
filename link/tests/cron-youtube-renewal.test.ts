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
      LINK_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) }) }) },
      WEB_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) },
      FLOW_URL: "https://flow.example",
      LINK_URL: "https://link.example",
      INTERNAL_SECRET: "secret",
      X_BEARER_TOKEN: "", TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "",
      TREND_RETENTION_DAYS: "30",
      ...overrides,
    } as any;
  }

  it("subscribes a pair referenced by a published flow with no existing lease", async () => {
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/acct1/UCabc"), "UCabc");
  });

  it("renews a pair whose lease is nearing expiry", async () => {
    const nearExpiry = new Date(Date.now() + 60_000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ lease_expires_at: nearExpiry }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/acct1/UCabc"), "UCabc");
  });

  it("does not renew a pair whose lease is not close to expiry", async () => {
    const farExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ lease_expires_at: farExpiry }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("skips a pair not referenced by any published flow, without unsubscribing or touching its lease row", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) }) }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [] }); // nothing referenced
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
  });

  it("does not touch subscriptions when the watches fetch fails", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null) }) }) };
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
