import { describe, it, expect, vi, beforeEach } from "vitest";
import { YouTubeTokenService } from "../../src/services/youtube-token";

function makeDb(config: Record<string, unknown>) {
  const state = { config: JSON.stringify(config) };
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => ({ config: state.config }),
            run: async () => { /* UPDATE writes captured below */ },
          };
        },
        _sql: sql,
      };
    },
    _state: state,
  } as unknown as D1Database & { _state: { config: string } };
}

describe("YouTubeTokenService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the stored token when it is not near expiry", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const db = makeDb({ access_token: "tok", refresh_token: "r", expires_at: future });
    const svc = new YouTubeTokenService(db, "id", "sec");
    expect(await svc.getValidToken("ch")).toBe("tok");
  });

  it("refreshes when expiring within 10 minutes and persists the new token", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const db = makeDb({ access_token: "old", refresh_token: "r", expires_at: soon });
    const runSpy = vi.fn(async (sql: string, args: unknown[]) => {});
    // capture UPDATE
    (db as any).prepare = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => ({ config: JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: soon }) }),
        run: async () => runSpy(sql, args),
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })));
    const svc = new YouTubeTokenService(db, "id", "sec");
    expect(await svc.getValidToken("ch")).toBe("new");
    expect(runSpy).toHaveBeenCalled();
  });

  it("throws when there is no refresh token", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const db = makeDb({ access_token: "old", expires_at: soon });
    const svc = new YouTubeTokenService(db, "id", "sec");
    await expect(svc.getValidToken("ch")).rejects.toThrow("No YouTube refresh token");
  });
});
