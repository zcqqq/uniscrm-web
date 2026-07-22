import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "victim-client-id", clientSecret: "victim-client-secret" });
const createAuthorizationURLMock = vi.fn().mockReturnValue(new URL("https://x.com/i/oauth2/authorize"));
const validateAuthorizationCodeMock = vi.fn();

vi.mock("arctic", () => ({
  Twitter: class {
    createAuthorizationURL(...args: unknown[]) {
      return createAuthorizationURLMock(...args);
    }
    validateAuthorizationCode(...args: unknown[]) {
      return validateAuthorizationCodeMock(...args);
    }
  },
  Google: class {},
  generateState: () => "state",
  generateCodeVerifier: () => "verifier",
  decodeIdToken: () => ({}),
}));

vi.mock("../src/services/app-credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/app-credentials")>();
  return { ...actual, getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args) };
});

vi.mock("../src/services/x-token", () => ({ XTokenService: class { updateConfig() { return Promise.resolve(); } } }));
vi.mock("../src/services/x-webhook", () => ({
  XActivityService: class {
    setupAllSubscriptions() { return Promise.resolve([]); }
    getWebhook() { return Promise.resolve(null); }
    createWebhook() { return Promise.resolve("wh"); }
  },
}));
vi.mock("../src/services/content", () => ({ ContentService: class {} }));
vi.mock("../src/channels/tiktok", () => ({ TikTokChannel: class {} }));
vi.mock("../../shared/tenant-data-db", () => ({ TenantDataDB: class {} }));
vi.mock("../../shared/credit-service", () => ({ getActiveSubscriptionTier: vi.fn() }));
vi.mock("../../shared/plans", () => ({ canUseFeature: vi.fn().mockReturnValue(true) }));
vi.mock("../src/services/pollers/poll-channel", () => ({ pollChannelOnce: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/services/youtube-account", () => ({ syncYouTubeSubscriptions: vi.fn() }));

import { oauthRoutes } from "../src/oauth";

const VICTIM_TENANT = 100001;
const ATTACKER_TENANT = 1;
const VICTIM_CHANNEL = "victim-byok-channel";

// Only answers a channel lookup when the query carries a tenant predicate that
// matches the row's owner — an unscoped lookup therefore still returns the row,
// which is what lets these tests fail against unscoped code.
function createMockLinkDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ sql, args });
      const row = { config: JSON.stringify({ is_byok: true, app_client_id: "enc" }), tenant_id: VICTIM_TENANT };
      const isChannelLookup = sql.includes("FROM channels WHERE id = ?");
      const scoped = sql.includes("tenant_id = ?");
      const asksForVictim = !scoped || args[1] === VICTIM_TENANT;
      return {
        first: vi.fn().mockResolvedValue(isChannelLookup && asksForVictim ? row : null),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
    }),
  }));
  return { prepare, calls };
}

function createMockKv(sessionTenantId: number | null) {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key.startsWith("session:")) {
        return Promise.resolve(
          sessionTenantId === null
            ? null
            : JSON.stringify({ tenant_id: sessionTenantId, member_id: "m1", email: "a@b.c" })
        );
      }
      return Promise.resolve(null);
    }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function buildApp() {
  const app = new Hono();
  app.route("/", oauthRoutes());
  return app;
}

const sessionCookie = { headers: { Cookie: "session=sess-1" } };

describe("GET /x/connect — BYOK channel ownership", () => {
  beforeEach(() => {
    getAppCredentialsMock.mockClear();
    createAuthorizationURLMock.mockClear();
  });

  it("refuses a channelId belonging to another tenant, without decrypting its app credentials", async () => {
    const kv = createMockKv(ATTACKER_TENANT);
    const linkDb = createMockLinkDb();

    const res = await buildApp().request(
      `/x/connect?channelId=${VICTIM_CHANNEL}`,
      sessionCookie,
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never
    );

    expect(res.status).toBe(404);
    // The leak was the victim's client_id reaching the authorization URL.
    expect(getAppCredentialsMock).not.toHaveBeenCalled();
    expect(createAuthorizationURLMock).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refuses a BYOK connect with no session at all", async () => {
    const kv = createMockKv(null);
    const linkDb = createMockLinkDb();

    const res = await buildApp().request(
      `/x/connect?channelId=${VICTIM_CHANNEL}`,
      {},
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never
    );

    expect(res.status).toBe(401);
    expect(getAppCredentialsMock).not.toHaveBeenCalled();
  });

  it("still connects the tenant's own BYOK channel", async () => {
    const kv = createMockKv(VICTIM_TENANT);
    const linkDb = createMockLinkDb();

    const res = await buildApp().request(
      `/x/connect?channelId=${VICTIM_CHANNEL}`,
      sessionCookie,
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never
    );

    expect(res.status).toBe(302);
    expect(getAppCredentialsMock).toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalled();
  });
});

describe("GET /x/callback — BYOK channel ownership", () => {
  beforeEach(() => {
    getAppCredentialsMock.mockClear();
    validateAuthorizationCodeMock.mockReset().mockResolvedValue({
      accessToken: () => "tok",
      hasRefreshToken: () => false,
      refreshToken: () => null,
      accessTokenExpiresInSeconds: () => 7200,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "attacker-x-id", name: "A", username: "attacker" } }), { status: 200 })
    ));
  });

  it("does not write the caller's X account into another tenant's channel row", async () => {
    const linkDb = createMockLinkDb();
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        codeVerifier: "verifier",
        tenantId: String(ATTACKER_TENANT),
        memberId: "m1",
        byokChannelId: VICTIM_CHANNEL,
      })),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const res = await buildApp().request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never
    );

    expect(res.status).toBe(404);
    // No token exchange, and above all no UPDATE against the victim's row.
    expect(validateAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(linkDb.calls.some((c) => c.sql.includes("UPDATE channels"))).toBe(false);
  });

  it("rejects a BYOK state carrying no tenant", async () => {
    const linkDb = createMockLinkDb();
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        codeVerifier: "verifier",
        byokChannelId: VICTIM_CHANNEL,
      })),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const res = await buildApp().request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never
    );

    expect(res.status).toBe(401);
    expect(linkDb.calls.some((c) => c.sql.includes("UPDATE channels"))).toBe(false);
  });
});
