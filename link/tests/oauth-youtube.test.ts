import { describe, it, expect, vi, beforeEach } from "vitest";
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

// resolveSession reads the `session` cookie and looks it up in KV first. Without both, the
// route now refuses before it ever builds Google's authorization URL.
const SESSION_COOKIE = { Cookie: "session=sess-1" };
function createSessionKv() {
  return {
    get: vi.fn().mockImplementation((key: string) =>
      Promise.resolve(key === "session:sess-1" ? JSON.stringify({ tenant_id: 1, member_id: "member-1", email: "" }) : null)
    ),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GET /youtube/connect", () => {
  it("stores oauth state in KV and redirects to Google's authorization URL", async () => {
    const kv = createSessionKv();
    const app = buildApp();

    const res = await app.request("/youtube/connect", { headers: SESSION_COOKIE }, { KV: kv, WEB_DB: { prepare: vi.fn() }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(302);
    expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^oauth_state:/), expect.any(String), { expirationTtl: 300 });
  });

  it("requests prompt=consent select_account and access_type=offline so Google always shows the account chooser and returns a refresh token", async () => {
    const kv = createSessionKv();
    const app = buildApp();

    const res = await app.request("/youtube/connect", { redirect: "manual", headers: SESSION_COOKIE }, { KV: kv, WEB_DB: { prepare: vi.fn() }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    const location = res.headers.get("Location")!;
    expect(new URL(location).searchParams.get("prompt")).toBe("consent select_account");
    expect(new URL(location).searchParams.get("access_type")).toBe("offline");
  });

  // The callback hard-requires tenantId+memberId, so a sessionless start was always doomed —
  // it just failed AFTER the user had picked a Google account, clicked through the unverified-
  // app warning and granted consent, landing on a raw JSON 401 with nothing connected.
  it("refuses without a session instead of sending the user through Google's consent flow first", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/connect", { redirect: "manual" }, { KV: kv, WEB_DB: { prepare: vi.fn().mockReturnValue({ bind: () => ({ first: async () => null }) }) }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(401);
    // No state written, and no redirect to Google — the refusal is what the user sees first.
    expect(kv.put).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("GET /youtube/callback", () => {
  beforeEach(() => {
    // The callback fetches the connected channel's own title (channels.list)
    // right after token exchange, to use as the display name instead of the
    // Google login email — mirrors the X callback's `users/me` fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [{ snippet: { title: "Test Channel" } }] }), { status: 200 })
      )
    );
  });

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

  it("stores the channel's own title (channels.list) instead of relying on the OAuth email for display", async () => {
    // The Google ID token's `email` claim is the login identity, not the channel
    // name — for a Brand Account it's a synthetic "xxx@pages.plusgoogle.com"
    // placeholder. The callback must fetch and persist the actual channel title.
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "xxx@pages.plusgoogle.com" });

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    const linkDb = createMockLinkDb([
      ["channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id", { id: "row-1" }],
    ]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    await app.request(
      "/youtube/callback?code=abc&state=xyz",
      {},
      { KV: kv, LINK_DB: linkDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any,
      ctx as any
    );
    await flush();

    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    const config = JSON.parse(insertCall!.args[1] as string);
    expect(config.channel_title).toBe("Test Channel");
    expect(config.email).toBe("xxx@pages.plusgoogle.com");
  });

  it("stores a null channel_title (not a thrown error) when the channels.list fetch fails", async () => {
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 500 })));

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
    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    const config = JSON.parse(insertCall!.args[1] as string);
    expect(config.channel_title).toBeNull();
  });

  // Google's chooser lists every signed-in identity plus any Brand Accounts and gives no hint
  // which of them owns a channel. Landing on one that owns none used to produce a channel row
  // with no title and no subscriptions — a card that looks connected and does nothing.
  it("refuses to create a channel when the chosen Google account owns no YouTube channel, and says why", async () => {
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })));
    // No clearMocks in this project's vitest config — the sync mock carries calls from the
    // tests above, so the "not called" assertion below only means anything after a clear.
    syncYouTubeSubscriptionsMock.mockClear();

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    const linkDb = createMockLinkDb([]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    const res = await app.request(
      "/youtube/callback?code=abc&state=xyz",
      { redirect: "manual" },
      { KV: kv, LINK_DB: linkDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any,
      ctx as any
    );
    await flush();

    expect(res.status).toBe(302);
    // The reason rides back on the URL — the callback is a top-level redirect and cannot
    // render anything itself, and a raw JSON error page leaves the tenant with no way back.
    expect(new URL(res.headers.get("Location")!).search).toBe("?youtube_error=no_channel");
    expect(linkDb.calls.some((c) => c.sql.includes("INSERT INTO channels"))).toBe(false);
    expect(syncYouTubeSubscriptionsMock).not.toHaveBeenCalled();
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

  it("persists the refresh token from a fresh consent grant", async () => {
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok-3",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
      refreshToken: () => "rt-happy",
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
    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    expect(insertCall).toBeDefined();
    const config = JSON.parse(insertCall!.args[1] as string);
    expect(config.refresh_token).toBe("rt-happy");
  });

  it("preserves a previously stored refresh token when Google's response omits one on reconnect", async () => {
    // Google only returns refresh_token on the FIRST consent grant for a given
    // scope set — a reconnect where the user has already consented can omit it.
    // The upsert is unconditional (config = excluded.config), so without
    // preservation logic this would silently null out a working refresh token.
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok-4",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
      // No refreshToken() method — mirrors arctic's real shape when Google's
      // token response has no refresh_token field.
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    const existingConfig = JSON.stringify({
      google_user_id: "google-user-1",
      email: "tenant@example.com",
      access_token: "old-access-tok",
      refresh_token: "rt-old",
      expires_at: "2020-01-01T00:00:00.000Z",
      subscriptions: [],
      sync_status: "pending",
      last_synced_at: null,
    });
    const linkDb = createMockLinkDb([
      // Regression guard for the "AND is_active = 1" filter bug: disconnect
      // only flips is_active to 0 (does not clear source_channel_id), so at
      // callback time the prior row is still is_active = 0 — reactivation to
      // 1 happens later, inside the upsert. If the preserve-SELECT were to
      // reintroduce "AND is_active = 1" it would produce exactly this SQL
      // text and find nothing (simulated here as null), which would silently
      // null out rt-old below and fail the final assertion.
      ["SELECT config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id = ? AND is_active = 1", null],
      ["SELECT config FROM channels", { config: existingConfig }],
      ["SELECT id FROM channels", { id: "existing-row-id" }],
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

    // Direct assertion on the preserve-SELECT's SQL text: it must match on
    // source_channel_id alone and must NOT filter on is_active, since the
    // disconnect→reconnect row this exists to protect is is_active = 0 at
    // this point in the request.
    const preserveSelectCall = linkDb.calls.find((c) => c.sql.startsWith("SELECT config FROM channels"));
    expect(preserveSelectCall).toBeDefined();
    expect(preserveSelectCall!.sql).toContain("source_channel_id");
    expect(preserveSelectCall!.sql).not.toContain("is_active = 1");

    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    expect(insertCall).toBeDefined();
    const config = JSON.parse(insertCall!.args[1] as string);
    expect(config.refresh_token).toBe("rt-old");
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
