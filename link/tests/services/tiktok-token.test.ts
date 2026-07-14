import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TikTokTokenService } from "../../src/services/tiktok-token";

function createMockDb(config: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue({ config: JSON.stringify(config) }),
      run,
    }),
  }));
  return { prepare, run };
}

describe("TikTokTokenService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshAccessToken exchanges the refresh_token and persists the new tokens", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-tok", refresh_token: "new-refresh", expires_in: 86400 }), { status: 200 })
    );
    const db = createMockDb({ refresh_token: "old-refresh", access_token: "old-tok" });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.refreshAccessToken("chan-1");

    expect(token).toBe("new-tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("client_key")).toBe("client-key");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(db.run).toHaveBeenCalled();
  });

  it("getValidToken returns the existing token when not near expiry", async () => {
    const db = createMockDb({
      access_token: "still-good",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getValidToken proactively refreshes when expiring within 10 minutes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "refreshed", expires_in: 86400 }), { status: 200 })
    );
    const db = createMockDb({
      access_token: "expiring-soon",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("refreshed");
    expect(fetchMock).toHaveBeenCalled();
  });
});
