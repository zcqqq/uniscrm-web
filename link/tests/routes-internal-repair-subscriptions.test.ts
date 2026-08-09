import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Manual trigger for the subscription repair. It exists because the unattended path only runs
// hourly AND only inside the token-refresh window, so every diagnosis of this chain used to
// cost a two-hour wait. It must call the SAME ensureXSubscriptions the cron calls — a repair
// that only works by hand proves nothing about the path that runs unattended.

const ensureMock = vi.fn();
vi.mock("../src/services/x-subscription-repair", () => ({
  ensureXSubscriptions: (...args: unknown[]) => ensureMock(...args),
}));

const getValidTokenMock = vi.fn();
vi.mock("../src/services/x-token", () => ({
  XTokenService: class {
    getValidToken(...args: unknown[]) { return getValidTokenMock(...args); }
    updateConfig = vi.fn();
  },
}));

vi.mock("../src/services/app-credentials", async (importActual) => ({
  ...(await importActual<typeof import("../src/services/app-credentials")>()),
  getAppCredentials: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csec", bearerToken: "bearer" }),
}));

import { internalRoutes } from "../src/routes-internal";

const CHANNEL_ID = "chan-1";

function db(row: Record<string, unknown> | null) {
  return { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database;
}
const CHANNEL_ROW = { id: CHANNEL_ID, config: JSON.stringify({ is_byok: true, x_user_id: "3245609912" }) };

function post(query: string, database: D1Database) {
  const app = new Hono();
  app.route("/internal", internalRoutes());
  return app.request(`/internal/x/repair-subscriptions${query}`, { method: "POST", headers: { "X-Internal-Secret": "s3cret" } },
    { LINK_DB: database, INTERNAL_SECRET: "s3cret", LINK_URL: "https://link-dev.uni-scrm.com" } as never);
}

beforeEach(() => {
  ensureMock.mockReset().mockResolvedValue({ ok: true, webhookId: "wh-1", webhookUrl: "https://link-dev.uni-scrm.com/x/webhook/3245609912", subscriptionIds: ["s1", "s2"] });
  getValidTokenMock.mockReset().mockResolvedValue("user-token");
});

describe("POST /internal/x/repair-subscriptions", () => {
  it("runs the shared repair with a valid user token and returns what it built", async () => {
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, webhookId: "wh-1", subscriptionIds: ["s1", "s2"] });

    expect(getValidTokenMock).toHaveBeenCalledWith(CHANNEL_ID);
    // Same function the cron calls, and the user token is the one getValidToken vouched for.
    const [, channelId, config, , token] = ensureMock.mock.calls[0];
    expect(channelId).toBe(CHANNEL_ID);
    expect((config as { x_user_id: string }).x_user_id).toBe("3245609912");
    expect(token).toBe("user-token");
  });

  it("400s a repair the shared function declined (e.g. channel never authorized)", async () => {
    ensureMock.mockResolvedValue({ ok: false, error: "channel has no x_user_id — it has not been authorized yet" });
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("x_user_id");
  });

  // getValidToken refuses deactivated and frozen channels; that refusal must surface, not 200.
  it("502s when the token is unavailable, without attempting the repair", async () => {
    getValidTokenMock.mockRejectedValue(new Error("channel_frozen: X locked the account"));
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toContain("channel_frozen");
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("400s without a channelId and 404s an unknown or inactive channel", async () => {
    expect((await post("", db(null))).status).toBe(400);
    expect((await post("?channelId=nope", db(null))).status).toBe(404);
  });
});
