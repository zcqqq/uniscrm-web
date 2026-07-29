import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectFreeze, readFrozenState, markChannelFrozen, clearChannelFrozen } from "../../src/services/x-freeze";
import { XTokenService } from "../../src/services/x-token";
import { handleFrozenProbe } from "../../src/cron";

const LOCKED_BODY = JSON.stringify({
  errors: [{ code: 326, message: "To protect our users from spam and other malicious activity, this account is temporarily locked. Please log in to https://twitter.com to unlock your account." }],
});

describe("detectFreeze", () => {
  it("recognizes the temporary-lock code X returns for a locked account", () => {
    const signal = detectFreeze(403, LOCKED_BODY);
    expect(signal?.code).toBe(326);
    expect(signal?.message).toContain("temporarily locked");
  });

  it.each([63, 64])("recognizes suspension code %i", (code) => {
    expect(detectFreeze(403, JSON.stringify({ errors: [{ code, message: "User has been suspended" }] }))?.code).toBe(code);
  });

  it("accepts an already-parsed body as well as raw text", () => {
    expect(detectFreeze(403, { errors: [{ code: 326, message: "temporarily locked" }] })?.code).toBe(326);
  });

  // The whole reason detection is text/code-based rather than status-based: X answers 403 for
  // ordinary refusals too — the bookmark endpoint does it for the retweet cap — and treating a
  // bare 403 as a freeze would silently pause a perfectly healthy channel.
  it("does NOT treat an ordinary 403 as a freeze", () => {
    expect(detectFreeze(403, JSON.stringify({ title: "Forbidden", detail: "You have exceeded the retweet limit." }))).toBeNull();
    expect(detectFreeze(403, "")).toBeNull();
    expect(detectFreeze(403, JSON.stringify({ errors: [{ code: 187, message: "Status is a duplicate" }] }))).toBeNull();
  });

  it("ignores every other status, freeze wording or not", () => {
    expect(detectFreeze(429, LOCKED_BODY)).toBeNull();
    expect(detectFreeze(401, LOCKED_BODY)).toBeNull();
    expect(detectFreeze(200, LOCKED_BODY)).toBeNull();
  });

  it("falls back to matching non-JSON bodies", () => {
    expect(detectFreeze(403, "this account is temporarily locked")?.code).toBe(0);
    expect(detectFreeze(403, "<html>gateway error</html>")).toBeNull();
  });
});

describe("readFrozenState", () => {
  it("reads the state written into a channel config", () => {
    const state = readFrozenState({ x_frozen_at: "2026-07-29T02:00:00.000Z", x_frozen_code: 326, x_frozen_message: "locked" });
    expect(state).toEqual({ frozenAt: "2026-07-29T02:00:00.000Z", code: 326, message: "locked" });
  });

  it("is null for a healthy channel", () => {
    expect(readFrozenState({ access_token: "tok" })).toBeNull();
    expect(readFrozenState(null)).toBeNull();
  });
});

function createMockDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: unknown[]) => {
        calls.push({ sql, params });
        return { run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }) };
      }),
    })),
  };
}

describe("markChannelFrozen / clearChannelFrozen", () => {
  // json_set rather than a read-modify-write of the whole config: XTokenService rewrites config
  // wholesale on every token refresh, so a concurrent refresh would otherwise drop the flag.
  it("writes the flag with json_set and only when not already frozen", async () => {
    const db = createMockDb();
    await markChannelFrozen(db as any, "chan-1", { code: 326, message: "temporarily locked" });

    const { sql, params } = db.calls[0];
    expect(sql).toContain("json_set(config");
    expect(sql).toContain("json_extract(config, '$.x_frozen_at') IS NULL");
    expect(params[1]).toBe(326);
    expect(params[3]).toBe("chan-1");
  });

  it("clears every freeze key again", async () => {
    const db = createMockDb();
    await clearChannelFrozen(db as any, "chan-1");

    const { sql } = db.calls[0];
    expect(sql).toContain("json_remove(config");
    expect(sql).toContain("$.x_frozen_at");
    expect(sql).toContain("$.x_frozen_message");
  });
});

describe("XTokenService.getValidToken with a frozen channel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function dbWithConfig(config: Record<string, unknown>) {
    return {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ config: JSON.stringify(config), is_active: 1 }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        }),
      }),
    };
  }

  it("hands out no token and calls nothing while the account is frozen", async () => {
    const db = dbWithConfig({
      access_token: "tok", refresh_token: "r",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      x_frozen_at: "2026-07-29T02:00:00.000Z", x_frozen_code: 326, x_frozen_message: "temporarily locked",
    });
    const service = new XTokenService(db as any, "cid", "csecret");

    await expect(service.getValidToken("chan-1")).rejects.toThrow("channel_frozen");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The guard has to sit ahead of the proactive-refresh branch, or an expiring token would
  // still reach /2/oauth2/token on a locked account.
  it("refuses even when the token is expiring", async () => {
    const db = dbWithConfig({
      access_token: "tok", refresh_token: "r",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
      x_frozen_at: "2026-07-29T02:00:00.000Z", x_frozen_code: 326, x_frozen_message: "temporarily locked",
    });
    const service = new XTokenService(db as any, "cid", "csecret");

    await expect(service.getValidToken("chan-1")).rejects.toThrow("channel_frozen");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleFrozenProbe", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function probeEnv(config: Record<string, unknown>) {
    const runs: string[] = [];
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        all: vi.fn().mockResolvedValue({ results: [{ id: "chan-1", config: JSON.stringify(config) }] }),
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockImplementation(async () => { runs.push(sql); return { success: true, meta: { changes: 1 } }; }),
          first: vi.fn().mockResolvedValue({ config: JSON.stringify(config), is_active: 1 }),
        }),
      })),
    };
    return { env: { LINK_DB: linkDb } as any, runs, linkDb };
  }

  const frozenConfig = {
    access_token: "tok", refresh_token: "r",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    x_frozen_at: "2026-07-29T02:00:00.000Z", x_frozen_code: 326, x_frozen_message: "temporarily locked",
  };

  it("clears the freeze as soon as X answers the probe", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "1" } }), { status: 200 }));
    const { env, runs } = probeEnv(frozenConfig);

    await handleFrozenProbe(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.x.com/2/users/me");
    expect(runs.some((sql) => sql.includes("json_remove(config"))).toBe(true);
  });

  it("leaves the channel frozen while X still refuses, and probes only once", async () => {
    fetchMock.mockResolvedValue(new Response(LOCKED_BODY, { status: 403 }));
    const { env, runs } = probeEnv(frozenConfig);

    await handleFrozenProbe(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runs.some((sql) => sql.includes("json_remove(config"))).toBe(false);
  });

  it("selects only frozen, active X channels", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { env, linkDb } = probeEnv(frozenConfig);

    await handleFrozenProbe(env);

    const sql = linkDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("json_extract(config, '$.x_frozen_at') IS NOT NULL");
    expect(sql).toContain("is_active = 1");
  });
});
