import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { XTokenService } from "../../src/services/x-token";

function createMockDb(config: Record<string, unknown>, opts: { lockChanges?: number } = {}) {
  let stored = JSON.stringify(config);
  const lockChanges = opts.lockChanges ?? 1;

  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...bindArgs: unknown[]) => ({
      first: vi.fn().mockImplementation(async () => ({ config: stored })),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes("token_refresh_lock_until = datetime")) {
          return { success: true, meta: { changes: lockChanges } };
        }
        if (sql.includes("SET config = ?")) {
          stored = bindArgs[0] as string;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      }),
    })),
  }));

  return { prepare, getStored: () => stored };
}

describe("XTokenService", () => {
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
      new Response(JSON.stringify({ access_token: "new-tok", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 })
    );
    const db = createMockDb({ refresh_token: "old-refresh", access_token: "old-tok" });
    const service = new XTokenService(db as any, "client-id", "client-secret");

    const token = await service.refreshAccessToken("chan-1");

    expect(token).toBe("new-tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(JSON.parse(db.getStored()).refresh_token).toBe("new-refresh");
  });

  it("getValidToken returns the existing token when not near expiry", async () => {
    const db = createMockDb({
      access_token: "still-good",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const service = new XTokenService(db as any, "client-id", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getValidToken proactively refreshes when expiring within 10 minutes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "refreshed", expires_in: 7200 }), { status: 200 })
    );
    const db = createMockDb({
      access_token: "expiring-soon",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const service = new XTokenService(db as any, "client-id", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("refreshed");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refreshAccessToken releases the lock after a successful refresh", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-tok", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 })
    );
    const db = createMockDb({ refresh_token: "old-refresh", access_token: "old-tok" });
    const service = new XTokenService(db as any, "client-id", "client-secret");

    await service.refreshAccessToken("chan-1");

    const releaseCall = db.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("token_refresh_lock_until = NULL"));
    expect(releaseCall).toBeDefined();
  });

  it("refreshAccessToken releases the lock even when the token exchange fails", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));
    const db = createMockDb({ refresh_token: "old-refresh", access_token: "old-tok" });
    const service = new XTokenService(db as any, "client-id", "client-secret");

    await expect(service.refreshAccessToken("chan-1")).rejects.toThrow("Token refresh failed 500");

    const releaseCall = db.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("token_refresh_lock_until = NULL"));
    expect(releaseCall).toBeDefined();
  });

  it("refreshAccessToken adopts the concurrent winner's token instead of calling X when the lock is already held", async () => {
    vi.useFakeTimers();
    try {
      const db = createMockDb({ refresh_token: "old-refresh", access_token: "already-refreshed-by-winner" }, { lockChanges: 0 });
      const service = new XTokenService(db as any, "client-id", "client-secret");

      const tokenPromise = service.refreshAccessToken("chan-1");
      await vi.runAllTimersAsync();
      const token = await tokenPromise;

      expect(token).toBe("already-refreshed-by-winner");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
