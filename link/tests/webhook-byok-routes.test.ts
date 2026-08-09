import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// getAppCredentials decrypts the BYOK app's stored credentials against the Secrets Store key;
// these tests are about routing + signature gating, so it is faked down to a fixed secret.
const BYOK_CONSUMER_SECRET = "byok-consumer-secret";
vi.mock("../src/services/app-credentials", async (importActual) => ({
  ...(await importActual<typeof import("../src/services/app-credentials")>()),
  // Literal, not the const above: vi.mock is hoisted above every top-level binding.
  getAppCredentials: vi.fn().mockResolvedValue({
    clientId: "cid",
    clientSecret: "csec",
    consumerSecret: "byok-consumer-secret",
    bearerToken: "bearer",
  }),
}));

const handledChannelIds: string[] = [];
vi.mock("../../shared/tenant-data-db", () => ({ TenantDataDB: class {} }));

import { webhookRoutes } from "../src/webhook";
import { XWebhookService } from "../src/services/x-webhook";

const CHANNEL_ROW_ID = "70ee0fcb-50f9-4963-9cd2-5870ddf5cf9e";
const X_USER_ID = "3245609912";

// Resolves exactly like the real query: active X channels matched on source_channel_id OR id.
function mockLinkDb(rows: Array<{ id: string; source_channel_id: string | null; is_active: number }>) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("source_channel_id = ? OR id = ?")) {
            const key = args[0] as string;
            const hit = rows.find((r) => r.is_active === 1 && (r.source_channel_id === key || r.id === key));
            return hit ? { id: hit.id, config: JSON.stringify({ is_byok: true }) } : null;
          }
          // handleXActivityEventByChannel's own tenant lookup — every test here stops before
          // the ingestion path matters, so report the channel as tenant-less and let it return.
          if (sql.includes("SELECT tenant_id FROM channels")) {
            handledChannelIds.push(args[0] as string);
            return { tenant_id: null };
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
}

function buildApp() {
  const app = new Hono();
  app.route("/x", webhookRoutes());
  return app;
}

const env = (db: D1Database) => ({ LINK_DB: db, WEB_DB: db, X_CONSUMER_SECRET: "system-secret" }) as never;

async function signedPost(app: Hono, path: string, body: unknown, db: D1Database, secret = BYOK_CONSUMER_SECRET) {
  const raw = JSON.stringify(body);
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-twitter-webhooks-signature": await new XWebhookService(secret).computeSignature(raw),
    },
    body: raw,
  }, env(db));
}

const FOLLOW_BODY = { data: { event_type: "follow.follow", filter: { user_id: X_USER_ID }, payload: {} } };

beforeEach(() => { handledChannelIds.length = 0; });

describe("BYOK webhook routing — path segment is the X user id", () => {
  const rows = [{ id: CHANNEL_ROW_ID, source_channel_id: X_USER_ID, is_active: 1 }];

  it("resolves a CRC challenge addressed by X user id", async () => {
    const res = await buildApp().request(`/x/webhook/${X_USER_ID}?crc_token=abc`, {}, env(mockLinkDb(rows)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_token: await new XWebhookService(BYOK_CONSUMER_SECRET).computeCrcResponse("abc"),
    });
  });

  // Webhooks registered before 2026-08-09 carry the channel row id and stay registered on X
  // until that app re-registers — dropping them would silence every connected BYOK channel
  // the moment this deploys.
  it("still resolves the legacy channel-row-id form", async () => {
    const res = await buildApp().request(`/x/webhook/${CHANNEL_ROW_ID}?crc_token=abc`, {}, env(mockLinkDb(rows)));
    expect(res.status).toBe(200);
  });

  it("404s an unknown key rather than answering the CRC with a system-app signature", async () => {
    const res = await buildApp().request("/x/webhook/999999?crc_token=abc", {}, env(mockLinkDb(rows)));
    expect(res.status).toBe(404);
  });

  it("does not resolve a soft-deleted channel", async () => {
    const db = mockLinkDb([{ id: CHANNEL_ROW_ID, source_channel_id: X_USER_ID, is_active: 0 }]);
    const res = await buildApp().request(`/x/webhook/${X_USER_ID}?crc_token=abc`, {}, env(db));
    expect(res.status).toBe(404);
  });

  it("hands the event to the resolved channel row id, not the path segment", async () => {
    const db = mockLinkDb(rows);
    const res = await signedPost(buildApp(), `/x/webhook/${X_USER_ID}`, FOLLOW_BODY, db);
    expect(res.status).toBe(200);
    expect(handledChannelIds).toEqual([CHANNEL_ROW_ID]);
  });
});

describe("BYOK webhook signature gate", () => {
  const rows = [{ id: CHANNEL_ROW_ID, source_channel_id: X_USER_ID, is_active: 1 }];

  // The path segment is now public, so the signature is the only thing separating a real
  // delivery from anyone who knows the account's numeric X id.
  it("403s an unsigned POST without touching the ingestion path", async () => {
    const db = mockLinkDb(rows);
    const res = await buildApp().request(`/x/webhook/${X_USER_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FOLLOW_BODY),
    }, env(db));
    expect(res.status).toBe(403);
    expect(handledChannelIds).toEqual([]);
  });

  it("403s a POST signed with the wrong app's consumer secret", async () => {
    const db = mockLinkDb(rows);
    const res = await signedPost(buildApp(), `/x/webhook/${X_USER_ID}`, FOLLOW_BODY, db, "not-this-app");
    expect(res.status).toBe(403);
    expect(handledChannelIds).toEqual([]);
  });

  it("403s when the body was altered after signing", async () => {
    const db = mockLinkDb(rows);
    const signature = await new XWebhookService(BYOK_CONSUMER_SECRET).computeSignature(JSON.stringify(FOLLOW_BODY));
    const res = await buildApp().request(`/x/webhook/${X_USER_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-twitter-webhooks-signature": signature },
      body: JSON.stringify({ ...FOLLOW_BODY, data: { ...FOLLOW_BODY.data, event_type: "follow.unfollow" } }),
    }, env(db));
    expect(res.status).toBe(403);
    expect(handledChannelIds).toEqual([]);
  });
});

describe("system webhook signature gate", () => {
  it("403s an unsigned POST to the shared /x/webhook", async () => {
    const db = mockLinkDb([]);
    const res = await buildApp().request("/x/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FOLLOW_BODY),
    }, env(db));
    expect(res.status).toBe(403);
  });

  it("accepts a POST signed with X_CONSUMER_SECRET", async () => {
    const db = mockLinkDb([]);
    const res = await signedPost(buildApp(), "/x/webhook", FOLLOW_BODY, db, "system-secret");
    expect(res.status).toBe(200);
  });
});
