import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const validateAuthorizationCodeMock = vi.fn();
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "byok-client-id", clientSecret: "byok-client-secret" });
const updateConfigMock = vi.fn().mockResolvedValue(undefined);
const setupAllSubscriptionsMock = vi.fn().mockResolvedValue(["sub-1"]);

vi.mock("arctic", () => ({
  Twitter: class {
    validateAuthorizationCode(...args: unknown[]) {
      return validateAuthorizationCodeMock(...args);
    }
    createAuthorizationURL() {
      return new URL("https://x.com/i/oauth2/authorize");
    }
  },
  generateState: () => "state",
  generateCodeVerifier: () => "verifier",
}));

vi.mock("../src/services/app-credentials", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
}));

vi.mock("../src/services/x-token", () => ({
  XTokenService: class {
    updateConfig(...args: unknown[]) {
      return updateConfigMock(...args);
    }
  },
}));

vi.mock("../src/services/x-webhook", () => ({
  XActivityService: class {
    setupAllSubscriptions(...args: unknown[]) {
      return setupAllSubscriptionsMock(...args);
    }
    getWebhook() {
      return Promise.resolve(null);
    }
    createWebhook() {
      return Promise.resolve("wh-id");
    }
  },
}));

vi.mock("../src/services/content", () => ({ ContentService: class {} }));
vi.mock("../src/channels/tiktok", () => ({ TikTokChannel: class {} }));
vi.mock("../../shared/tenant-data-db", () => ({ TenantDataDB: class {} }));
vi.mock("../../shared/credit-service", () => ({ getActiveSubscriptionTier: vi.fn() }));
vi.mock("../../shared/plans", () => ({ canUseFeature: vi.fn().mockReturnValue(true) }));

const pollChannelOnceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/pollers/poll-channel", () => ({
  pollChannelOnce: (...args: unknown[]) => pollChannelOnceMock(...args),
}));

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
        all: vi.fn().mockResolvedValue({ results: value ? [value] : [] }),
      };
    }),
  }));
  return { prepare, calls };
}

function createMockKv(byokChannelId: string) {
  return {
    get: vi.fn().mockResolvedValue(JSON.stringify({ codeVerifier: "verifier", tenantId: undefined, memberId: undefined, byokChannelId })),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function buildApp() {
  const app = new Hono();
  app.route("/", oauthRoutes());
  return app;
}

// The callback backgrounds the instant poll + subscription setup via
// c.executionCtx.waitUntil so the redirect isn't blocked on them. Hono's test
// request() has no real ExecutionContext, and asserting on the backgrounded
// mocks requires explicitly awaiting whatever was handed to waitUntil first.
function createMockExecutionCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p); }, passThroughOnException: () => {} },
    flush: () => Promise.all(promises),
  };
}

describe("X BYOK OAuth callback — channel conflict handling", () => {
  beforeEach(() => {
    validateAuthorizationCodeMock.mockReset().mockResolvedValue({
      accessToken: () => "access-tok",
      hasRefreshToken: () => true,
      refreshToken: () => "refresh-tok",
      accessTokenExpiresInSeconds: () => 7200,
    });
    getAppCredentialsMock.mockClear();
    updateConfigMock.mockClear();
    setupAllSubscriptionsMock.mockClear();
    pollChannelOnceMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "xuser-999", name: "Some Name", username: "somehandle" } }), { status: 200 })
      )
    );
  });

  it("frees the conflicting channel row's slot (deactivate + clear source_channel_id) and claims the account on byokChannelId instead of throwing a UNIQUE constraint error", async () => {
    const byokChannelId = "placeholder-chan";
    const oldChannelId = "old-system-app-chan";
    const kv = createMockKv(byokChannelId);
    const linkDb = createMockLinkDb([
      ["WHERE id = ? AND is_active = 1", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }) }],
      ["SELECT config, tenant_id FROM channels WHERE id = ?", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }), tenant_id: 5 }],
      ["channel_type = 'X' AND source_channel_id", { id: oldChannelId, tenant_id: 5 }],
    ]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    const res = await app.request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as any,
      ctx as any
    );
    await flush();

    expect(res.status).toBe(302);

    // The BYOK placeholder row is always the one that ends up active with is_byok=1 —
    // it already holds the BYOK app credentials, so there's nothing to merge into it.
    const updateCall = linkDb.calls.find((c) => c.sql.includes("is_byok = 1"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[updateCall!.args.length - 1]).toBe(byokChannelId);

    // The old (non-BYOK) row that previously held this X account is freed: deactivated,
    // source_channel_id cleared (so it never collides again), reason recorded for audit
    // and so tier-reactivation logic (admin/src/routes/webhook.ts) never touches it.
    const freeCall = linkDb.calls.find((c) => c.sql.includes("source_channel_id = NULL"));
    expect(freeCall).toBeDefined();
    expect(freeCall!.args).toEqual(["byok_merged source_channel_id=xuser-999", oldChannelId]);

    const pollSeedCalls = linkDb.calls.filter((c) => c.sql.includes("INSERT INTO channel_poll_state"));
    expect(pollSeedCalls).toHaveLength(2);
    for (const call of pollSeedCalls) {
      expect(call.args[0]).toBe(byokChannelId);
    }

    expect(pollChannelOnceMock).toHaveBeenCalledWith(expect.anything(), "X", byokChannelId);

    expect(setupAllSubscriptionsMock).toHaveBeenCalledWith("xuser-999", `http://localhost/x/webhook/${byokChannelId}`);
    expect(updateConfigMock).toHaveBeenCalledWith(byokChannelId, { subscription_ids: ["sub-1"] });
  });

  it("redirects without waiting for the instant poll and subscription setup — they run via executionCtx.waitUntil after the response", async () => {
    const byokChannelId = "placeholder-chan";
    const kv = createMockKv(byokChannelId);
    const linkDb = createMockLinkDb([
      ["WHERE id = ? AND is_active = 1", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }) }],
      ["SELECT config, tenant_id FROM channels WHERE id = ?", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }), tenant_id: 5 }],
      ["channel_type = 'X' AND source_channel_id", null],
    ]);

    // Never resolves for the duration of this test — if the handler awaited
    // this before redirecting, `app.request()` itself would hang.
    pollChannelOnceMock.mockReturnValue(new Promise(() => {}));

    try {
      const app = buildApp();
      const { ctx } = createMockExecutionCtx();
      const res = await app.request(
        "/x/callback?code=abc&state=state123",
        {},
        { KV: kv, LINK_DB: linkDb } as any,
        ctx as any
      );

      expect(res.status).toBe(302);
    } finally {
      // Restore for subsequent tests — mockClear() in beforeEach only clears
      // call history, not this returnValue override.
      pollChannelOnceMock.mockResolvedValue(undefined);
    }
  });

  it("updates the placeholder row itself (and sets is_byok=1) when no other channel claims that X account", async () => {
    const byokChannelId = "placeholder-chan";
    const kv = createMockKv(byokChannelId);
    const linkDb = createMockLinkDb([
      ["WHERE id = ? AND is_active = 1", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }) }],
      ["SELECT config, tenant_id FROM channels WHERE id = ?", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }), tenant_id: 5 }],
      ["channel_type = 'X' AND source_channel_id", null],
    ]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    const res = await app.request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as any,
      ctx as any
    );
    await flush();

    expect(res.status).toBe(302);

    const updateCall = linkDb.calls.find((c) => c.sql.includes("is_byok = 1"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[updateCall!.args.length - 1]).toBe(byokChannelId);

    expect(linkDb.calls.some((c) => c.sql.includes("source_channel_id = NULL"))).toBe(false);
  });

  it("refuses to merge across tenants and leaves both rows untouched", async () => {
    const byokChannelId = "placeholder-chan";
    const otherTenantChannelId = "other-tenant-chan";
    const kv = createMockKv(byokChannelId);
    const linkDb = createMockLinkDb([
      ["WHERE id = ? AND is_active = 1", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }) }],
      ["SELECT config, tenant_id FROM channels WHERE id = ?", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }), tenant_id: 5 }],
      ["channel_type = 'X' AND source_channel_id", { id: otherTenantChannelId, tenant_id: 999 }],
    ]);

    const app = buildApp();
    const res = await app.request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as any
    );

    expect(res.status).toBe(409);
    expect(linkDb.calls.some((c) => c.sql.includes("is_byok = 1"))).toBe(false);
    expect(linkDb.calls.some((c) => c.sql.includes("source_channel_id = NULL"))).toBe(false);
  });
});

describe("TikTok OAuth callback", () => {
  beforeEach(() => {
    pollChannelOnceMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("oauth/token")) {
          return Promise.resolve(new Response(JSON.stringify({ open_id: "tt-user-1", access_token: "tt-tok", expires_in: 86400 }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ data: { user: { open_id: "tt-user-1", display_name: "Name" } } }), { status: 200 }));
      })
    );
  });

  it("seeds channel_poll_state for poller_name='content' and calls pollChannelOnce", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ tenantId: "5", memberId: "m1" })),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const linkDb = createMockLinkDb([]);

    const app = buildApp();
    const res = await app.request(
      "/tiktok/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) } } as any
    );

    expect(res.status).toBe(302);
    const seedCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channel_poll_state"));
    expect(seedCall).toBeDefined();
    expect(seedCall!.sql).toContain("'content'");
    expect(pollChannelOnceMock).toHaveBeenCalledWith(expect.anything(), "TIKTOK", expect.any(String));
  });

  it("on re-authorization (ON CONFLICT path), uses the existing row's real id — not the freshly-generated phantom id — for poll state seeding and the instant poll", async () => {
    const existingChannelId = "existing-tiktok-chan";
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ tenantId: "5", memberId: "m1" })),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    // Simulate the channels INSERT hitting ON CONFLICT and updating a pre-existing
    // row: the re-query for the active row must return that row's real id, which
    // differs from whatever fresh UUID crypto.randomUUID() generated locally.
    const linkDb = createMockLinkDb([
      ["channel_type = 'TIKTOK' AND source_channel_id", { id: existingChannelId }],
    ]);

    const app = buildApp();
    const res = await app.request(
      "/tiktok/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) } } as any
    );

    expect(res.status).toBe(302);

    const seedCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channel_poll_state"));
    expect(seedCall).toBeDefined();
    expect(seedCall!.args[0]).toBe(existingChannelId);

    expect(pollChannelOnceMock).toHaveBeenCalledWith(expect.anything(), "TIKTOK", existingChannelId);
  });
});

describe("TikTok OAuth connect", () => {
  it("includes video.upload in the scope (required for photo-post's MEDIA_UPLOAD mode)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/tiktok/connect",
      {},
      { KV: { put: vi.fn().mockResolvedValue(undefined) }, TIKTOK_CLIENT_KEY: "test-client-key" } as any
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") || "";
    // The connect URL is built as a plain (unencoded) template literal -- see the existing
    // line below being changed in Step 3 -- so the comma-separated scope list appears in the
    // Location header literally, not percent-encoded.
    expect(location).toContain("scope=user.info.basic,video.list,video.upload");
  });
});
