import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const validateAuthorizationCodeMock = vi.fn();
const decodeIdTokenMock = vi.fn();

vi.mock("arctic", () => ({
  Twitter: class {},
  Google: class {
    validateAuthorizationCode(...args: unknown[]) {
      return validateAuthorizationCodeMock(...args);
    }
    createAuthorizationURL() {
      return new URL("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
    }
  },
  generateState: () => "state123",
  generateCodeVerifier: () => "verifier",
  decodeIdToken: (...args: unknown[]) => decodeIdTokenMock(...args),
}));

const syncYouTubeSubscriptionsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/youtube-account", () => ({
  syncYouTubeSubscriptions: (...args: unknown[]) => syncYouTubeSubscriptionsMock(...args),
}));

vi.mock("../src/services/app-credentials", () => ({ getAppCredentials: vi.fn() }));
vi.mock("../src/services/x-token", () => ({ XTokenService: class {} }));
vi.mock("../src/services/x-webhook", () => ({ XActivityService: class {} }));
vi.mock("../src/services/pollers/poll-channel", () => ({ pollChannelOnce: vi.fn() }));
vi.mock("../../shared/credit-service", () => ({ getActiveSubscriptionTier: vi.fn() }));
vi.mock("../../shared/plans", () => ({ canUseFeature: vi.fn().mockReturnValue(true) }));

import { oauthRoutes } from "../src/oauth";

type MockRow = Record<string, unknown> | null;

function createMockLinkDb(responses: Array<[string, MockRow]>) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ sql, args });
      const match = responses.find(([key]) => sql.includes(key));
      const value = match ? match[1] : null;
      return {
        first: vi.fn().mockResolvedValue(value),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
    }),
  }));
  return { prepare, calls };
}

function createMockKv(stored: Record<string, unknown> | null) {
  return {
    get: vi.fn().mockResolvedValue(stored ? JSON.stringify(stored) : null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutionCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p); }, passThroughOnException: () => {} },
    flush: () => Promise.all(promises),
  };
}

function buildApp() {
  const app = new Hono();
  app.route("/", oauthRoutes());
  return app;
}

describe("GET /youtube/connect", () => {
  it("stores oauth state in KV and redirects to Google's authorization URL", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/connect", {}, { KV: kv, WEB_DB: { prepare: vi.fn() }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(302);
    expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^oauth_state:/), expect.any(String), { expirationTtl: 300 });
  });

  it("requests prompt=select_account so Google always shows the account chooser instead of silently reusing the last session", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/connect", { redirect: "manual" }, { KV: kv, WEB_DB: { prepare: vi.fn() }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    const location = res.headers.get("Location")!;
    expect(new URL(location).searchParams.get("prompt")).toBe("select_account");
  });
});

describe("GET /youtube/callback", () => {
  it("upserts a YOUTUBE_ACCOUNT channel row and backgrounds the subscription sync", async () => {
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    const linkDb = createMockLinkDb([
      ["channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id", { id: "row-1" }],
    ]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    const res = await app.request(
      "/youtube/callback?code=abc&state=xyz",
      {},
      { KV: kv, LINK_DB: linkDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any,
      ctx as any
    );
    await flush();

    expect(res.status).toBe(302);
    expect(kv.delete).toHaveBeenCalledWith("oauth_state:xyz");

    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain("YOUTUBE_ACCOUNT");
    expect(insertCall!.sql).toContain("ON CONFLICT(channel_type, source_channel_id) DO UPDATE");
    expect(insertCall!.args).toContain("1:google-user-1");

    const selectCall = linkDb.calls.find(
      (c) => c.sql.startsWith("SELECT id FROM channels") && c.sql.includes("channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id")
    );
    expect(selectCall).toBeDefined();
    expect(selectCall!.args).toContain("1:google-user-1");

    // The follow-up SELECT resolves the real row id (post-upsert), and that's
    // what gets passed to the sync — not the pre-generated (possibly discarded)
    // channelId from the INSERT.
    expect(syncYouTubeSubscriptionsMock).toHaveBeenCalledWith(expect.anything(), "row-1", "access-tok");
  });

  it("reconnecting after a prior disconnect (inactive row, same source_channel_id) does not throw and still redirects", async () => {
    // Regression test: disconnect only flips is_active to 0, it does not clear
    // source_channel_id. The unique index on (channel_type, source_channel_id)
    // is unconditional, so a plain re-INSERT on reconnect would violate it. The
    // atomic ON CONFLICT upsert must handle this without an unhandled exception.
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok-2",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    // The follow-up SELECT (after the upsert) finds the pre-existing row,
    // now reactivated by the ON CONFLICT DO UPDATE (is_active = 1).
    const linkDb = createMockLinkDb([
      ["channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id", { id: "existing-row-id" }],
    ]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();

    let thrown: unknown = null;
    let res: Response;
    try {
      res = await app.request(
        "/youtube/callback?code=abc&state=xyz",
        {},
        { KV: kv, LINK_DB: linkDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any,
        ctx as any
      );
      await flush();
    } catch (e) {
      thrown = e;
      res = undefined as unknown as Response;
    }

    expect(thrown).toBeNull();
    expect(res!.status).toBe(302);

    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    expect(insertCall!.sql).toContain("ON CONFLICT(channel_type, source_channel_id) DO UPDATE");

    expect(syncYouTubeSubscriptionsMock).toHaveBeenCalledWith(expect.anything(), "existing-row-id", "access-tok-2");
  });

  it("returns 400 when state is missing or expired", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/callback?code=abc&state=xyz", {}, { KV: kv, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(400);
  });

  it("returns 401 when the stored state has no tenant/member session", async () => {
    const kv = createMockKv({ codeVerifier: "verifier", tenantId: undefined, memberId: undefined });
    const app = buildApp();

    const res = await app.request("/youtube/callback?code=abc&state=xyz", {}, { KV: kv, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(401);
  });
});
