import { describe, it, expect, vi, beforeEach } from "vitest";

// The hourly token refresh carries the ONLY self-repair path for a BYOK channel that has no
// subscriptions. It ran ~48 times against dev between 2026-08-07 and 08-09 without ever
// repairing anything, and nothing here would have noticed.

const setupAllSubscriptionsMock = vi.fn().mockResolvedValue(["sub-1", "sub-2"]);
const getWebhookMock = vi.fn();
const createWebhookMock = vi.fn();
const updateConfigMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/services/x-webhook", async (importActual) => ({
  // byokWebhookUrl stays real — the URL shape is the thing under test.
  ...(await importActual<typeof import("../../src/services/x-webhook")>()),
  XActivityService: class {
    constructor(public token: string) {}
    getWebhook(...args: unknown[]) { return getWebhookMock(...args); }
    createWebhook(...args: unknown[]) { return createWebhookMock(...args); }
    setupAllSubscriptions(...args: unknown[]) { return setupAllSubscriptionsMock(...args); }
  },
}));

vi.mock("../../src/services/x-token", () => ({
  XTokenService: class {
    refreshAccessToken() { return Promise.resolve("fresh-user-token"); }
    updateConfig(...args: unknown[]) { return updateConfigMock(...args); }
  },
}));

vi.mock("../../src/services/app-credentials", async (importActual) => ({
  ...(await importActual<typeof import("../../src/services/app-credentials")>()),
  getAppCredentials: vi.fn().mockResolvedValue({
    clientId: "cid", clientSecret: "csec", consumerSecret: "consec", bearerToken: "app-only-bearer",
  }),
}));

vi.mock("../../src/services/tiktok-token", () => ({
  TikTokTokenService: class { refreshAccessToken() { return Promise.resolve("t"); } },
}));

import { handleTokenRefresh } from "../../src/cron";

const X_USER_ID = "3245609912";
const ROW_ID = "70ee0fcb-50f9-4963-9cd2-5870ddf5cf9e";

function envWith(config: Record<string, unknown>) {
  return {
    LINK_URL: "https://link-dev.uni-scrm.com",
    LINK_DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
        }),
        all: async () => ({
          // Only the X channel query returns a row; the TikTok one must stay empty.
          results: sql.includes("'TWITTER', 'X'") ? [{ id: ROW_ID, config: JSON.stringify(config) }] : [],
        }),
      }),
    },
  } as never;
}

const BYOK_CONFIG = {
  is_byok: true,
  x_user_id: X_USER_ID,
  refresh_token: "rt",
  // Already expired, so the refresh (and with it the repair branch) is due.
  expires_at: "2020-01-01T00:00:00.000Z",
};

beforeEach(() => {
  setupAllSubscriptionsMock.mockClear();
  getWebhookMock.mockReset().mockResolvedValue(null);
  createWebhookMock.mockReset().mockResolvedValue("wh-new");
  updateConfigMock.mockClear();
});

describe("handleTokenRefresh — BYOK subscription repair", () => {
  it("looks the webhook up by the X-user-id URL, so a reconnected channel matches the one already registered", async () => {
    getWebhookMock.mockResolvedValue({ webhook_id: "wh-existing", url: `https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}` });

    await handleTokenRefresh(envWith(BYOK_CONFIG));

    expect(getWebhookMock).toHaveBeenCalledWith(`https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}`);
    // The whole point: an already-registered webhook is reused, so X is never asked to create
    // a second one it has no room for.
    expect(createWebhookMock).not.toHaveBeenCalled();
    expect(setupAllSubscriptionsMock).toHaveBeenCalledWith(X_USER_ID, `https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}`, "wh-existing");
    // subscription_error is cleared on success (the repair shares ensureXSubscriptions with
    // the manual endpoint and the OAuth callback) — otherwise a channel that recovered still
    // reads as broken, which is exactly how the 2026-08-07 WebhookLimitExceeded error
    // outlived the condition that caused it.
    expect(updateConfigMock).toHaveBeenCalledWith(ROW_ID, expect.objectContaining({
      subscription_ids: ["sub-1", "sub-2"],
      subscription_error: null,
    }));
  });

  it("never puts the channel row id in the URL — that is what made the URL unregisterable after a reconnect", async () => {
    await handleTokenRefresh(envWith(BYOK_CONFIG));

    for (const call of [...getWebhookMock.mock.calls, ...createWebhookMock.mock.calls]) {
      expect(String(call[0])).not.toContain(ROW_ID);
    }
  });

  it("registers the webhook with the app-only bearer and subscribes with the fresh user token", async () => {
    await handleTokenRefresh(envWith(BYOK_CONFIG));
    expect(createWebhookMock).toHaveBeenCalledWith(`https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}`);
    expect(setupAllSubscriptionsMock).toHaveBeenCalledWith(X_USER_ID, `https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}`, "wh-new");
  });

  it("leaves a channel that already has subscriptions alone", async () => {
    await handleTokenRefresh(envWith({ ...BYOK_CONFIG, subscription_ids: ["sub-existing"] }));
    expect(getWebhookMock).not.toHaveBeenCalled();
    expect(setupAllSubscriptionsMock).not.toHaveBeenCalled();
  });

  it("uses the shared system webhook (no path segment) for a non-BYOK channel", async () => {
    await handleTokenRefresh(envWith({ ...BYOK_CONFIG, is_byok: false }));
    expect(getWebhookMock).toHaveBeenCalledWith("https://link-dev.uni-scrm.com/x/webhook");
  });
});
