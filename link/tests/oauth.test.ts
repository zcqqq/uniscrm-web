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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "xuser-999", name: "Some Name", username: "somehandle" } }), { status: 200 })
      )
    );
  });

  it("merges into the existing channel row sharing the same X account instead of throwing a UNIQUE constraint error", async () => {
    const byokChannelId = "placeholder-chan";
    const existingChannelId = "existing-chan";
    const kv = createMockKv(byokChannelId);
    const linkDb = createMockLinkDb([
      ["WHERE id = ? AND is_active = 1", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }) }],
      ["SELECT config, tenant_id FROM channels WHERE id = ?", { config: JSON.stringify({ is_byok: true, app_client_id: "enc-id" }), tenant_id: 5 }],
      ["channel_type = 'X' AND source_channel_id", { id: existingChannelId, tenant_id: 5 }],
    ]);

    const app = buildApp();
    const res = await app.request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as any
    );

    expect(res.status).toBe(302);

    const updateCall = linkDb.calls.find((c) => c.sql.includes("is_byok = 1"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[updateCall!.args.length - 1]).toBe(existingChannelId);

    const deactivateCall = linkDb.calls.find((c) => c.sql.includes("SET is_active = 0"));
    expect(deactivateCall).toBeDefined();
    expect(deactivateCall!.args).toEqual([byokChannelId]);

    const pollStateDeleteCall = linkDb.calls.find((c) => c.sql.includes("DELETE FROM channel_poll_state"));
    expect(pollStateDeleteCall).toBeDefined();
    expect(pollStateDeleteCall!.args).toEqual([byokChannelId]);

    const pollSeedCalls = linkDb.calls.filter((c) => c.sql.includes("INSERT INTO channel_poll_state"));
    expect(pollSeedCalls).toHaveLength(2);
    for (const call of pollSeedCalls) {
      expect(call.args[0]).toBe(existingChannelId);
    }

    expect(setupAllSubscriptionsMock).toHaveBeenCalledWith("xuser-999", `http://localhost/x/webhook/${existingChannelId}`);
    expect(updateConfigMock).toHaveBeenCalledWith(existingChannelId, { subscription_ids: ["sub-1"] });
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
    const res = await app.request(
      "/x/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb } as any
    );

    expect(res.status).toBe(302);

    const updateCall = linkDb.calls.find((c) => c.sql.includes("is_byok = 1"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[updateCall!.args.length - 1]).toBe(byokChannelId);

    expect(linkDb.calls.some((c) => c.sql.includes("SET is_active = 0"))).toBe(false);
    expect(linkDb.calls.some((c) => c.sql.includes("DELETE FROM channel_poll_state"))).toBe(false);
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
    expect(linkDb.calls.some((c) => c.sql.includes("SET is_active = 0"))).toBe(false);
  });
});
