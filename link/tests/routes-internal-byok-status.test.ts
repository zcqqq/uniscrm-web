import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Read-only diagnostics for "the subscriptions exist but X delivers nothing" — the app's
// bearer is encrypted at rest, so without this endpoint the only way to see X's own view of a
// channel is to add a log line, deploy, and wait for the hourly cron.
vi.mock("../src/services/app-credentials", async (importActual) => ({
  ...(await importActual<typeof import("../src/services/app-credentials")>()),
  getAppCredentials: vi.fn(async (_env: unknown, config: { app_bearer_token?: string }) => ({
    clientId: "cid", clientSecret: "csec", consumerSecret: "consec",
    bearerToken: config.app_bearer_token ? "app-only-bearer" : undefined,
  })),
}));

import { internalRoutes } from "../src/routes-internal";

const X_USER_ID = "3245609912";
const CHANNEL_ID = "chan-1";

function linkDbWith(row: Record<string, unknown> | null) {
  return {
    prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }),
  } as unknown as D1Database;
}

function channelRow(config: Record<string, unknown>) {
  return { id: CHANNEL_ID, tenant_id: 1, is_active: 1, source_channel_id: X_USER_ID, config: JSON.stringify(config) };
}

const BYOK_CONFIG = {
  is_byok: true,
  app_bearer_token: "enc-bearer",
  x_user_id: X_USER_ID,
  subscription_ids: ["sub-1"],
  subscription_error: null,
};

function buildApp() {
  const app = new Hono();
  app.route("/internal", internalRoutes());
  return app;
}

function get(app: Hono, query: string, db: D1Database) {
  return app.request(`/internal/x/byok-status${query}`, { headers: { "X-Internal-Secret": "s3cret" } }, { LINK_DB: db, INTERNAL_SECRET: "s3cret" } as never);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/2/webhooks")) {
      return new Response(JSON.stringify({ data: [{ id: "wh-1", url: `https://link-dev.uni-scrm.com/x/webhook/${X_USER_ID}`, valid: true }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [
        { subscription_id: "s1", event_type: "follow.follow", filter: { user_id: X_USER_ID } },
        { subscription_id: "s2", event_type: "follow.follow", filter: { user_id: "9999" } },
      ],
    }), { status: 200 });
  }));
});

describe("GET /internal/x/byok-status", () => {
  it("reports X's own view: the raw webhook list (valid flag included) and the subscriptions for THIS user", async () => {
    const res = await get(buildApp(), `?channelId=${CHANNEL_ID}`, linkDbWith(channelRow(BYOK_CONFIG)));
    expect(res.status).toBe(200);
    const body = await res.json<{ channel: Record<string, unknown>; x: Record<string, unknown> }>();

    expect(body.x.webhooks_status).toBe(200);
    // The `valid` flag is the whole point — getWebhook narrows the list to id+url and drops it.
    expect(JSON.stringify(body.x.webhooks)).toContain('"valid":true');
    expect(body.x.subscriptions_total).toBe(2);
    // Another tenant's subscription on the same shared app must not be counted as this user's.
    expect(body.x.subscriptions_for_user).toHaveLength(1);
    expect(body.channel.x_user_id).toBe(X_USER_ID);
    expect(body.channel.stored_subscription_ids).toEqual(["sub-1"]);
  });

  it("never leaks credentials in the response", async () => {
    const res = await get(buildApp(), `?channelId=${CHANNEL_ID}`, linkDbWith(channelRow(BYOK_CONFIG)));
    const raw = await res.text();
    expect(raw).not.toContain("app-only-bearer");
    expect(raw).not.toContain("enc-bearer");
    expect(raw).not.toContain("app_client_secret");
  });

  it("400s without a channelId", async () => {
    expect((await get(buildApp(), "", linkDbWith(null))).status).toBe(400);
  });

  it("404s an unknown channel", async () => {
    expect((await get(buildApp(), "?channelId=nope", linkDbWith(null))).status).toBe(404);
  });

  it("400s a channel whose app has no stored bearer, instead of calling X with undefined", async () => {
    const res = await get(buildApp(), `?channelId=${CHANNEL_ID}`, linkDbWith(channelRow({ ...BYOK_CONFIG, app_bearer_token: undefined })));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("no_app_bearer");
  });
});
