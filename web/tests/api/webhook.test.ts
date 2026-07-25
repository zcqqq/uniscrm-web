import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createWebhookRouter } from "../../worker/api/webhook";
import { RecommendService } from "../../worker/services/recommend";

// Pins tenant-db-removal task 11's fix to POST /api/webhook/trend-update: the route used to
// filter `WHERE d1_database_id IS NOT NULL` to only recompute recommendations for tenants
// whose per-tenant D1 provisioning had finished. That column (and the provisioning step
// itself) is gone, so the route now queries every tenant row unconditionally — this test
// pins that it computes for every row returned, and that one tenant throwing doesn't stop
// the sweep over the rest (the per-tenant try/catch in the route).

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("POST /api/webhook/trend-update", () => {
  const SECRET = "test-webhook-secret";
  let db: any;
  let app: Hono;
  let computeForUser: any;

  beforeEach(() => {
    computeForUser = vi.spyOn(RecommendService.prototype, "computeForUser").mockResolvedValue(undefined);

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = {
        WEB_DB: db,
        VECTORIZE: {},
        KV: {},
        WEBHOOK_SECRET: SECRET,
      };
      return next();
    });
    app.route("/webhook", createWebhookRouter());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without a signature header", async () => {
    db = { prepare: vi.fn() };
    const res = await app.request("/webhook/trend-update", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid signature", async () => {
    db = { prepare: vi.fn() };
    const res = await app.request("/webhook/trend-update", {
      method: "POST",
      headers: { "X-Webhook-Signature": "bad" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("computes recommendations for every tenant row, unfiltered by any provisioning flag", async () => {
    const rows = [{ tenant_id: 1 }, { tenant_id: 100000 }, { tenant_id: 100001 }];
    let capturedSql = "";
    db = {
      prepare: vi.fn((sql: string) => {
        capturedSql = sql;
        return { all: vi.fn().mockResolvedValue({ results: rows }) };
      }),
    };

    const body = "{}";
    const signature = await sign(body, SECRET);
    const res = await app.request("/webhook/trend-update", {
      method: "POST",
      headers: { "X-Webhook-Signature": signature },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenants_updated: 3 });
    // No WHERE clause left over from the removed d1_database_id gate.
    expect(capturedSql).toBe("SELECT tenant_id FROM tenants");
    expect(capturedSql).not.toContain("WHERE");
    expect(computeForUser).toHaveBeenCalledTimes(3);
    expect(computeForUser).toHaveBeenCalledWith(1, "global");
    expect(computeForUser).toHaveBeenCalledWith(100000, "global");
    expect(computeForUser).toHaveBeenCalledWith(100001, "global");
  });

  it("does not let one tenant's failure stop the rest of the sweep", async () => {
    const rows = [{ tenant_id: 1 }, { tenant_id: 2 }, { tenant_id: 3 }];
    db = {
      prepare: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: rows }) })),
    };
    computeForUser.mockImplementation(async (tenantId: number) => {
      if (tenantId === 2) throw new Error("boom");
    });

    const body = "{}";
    const signature = await sign(body, SECRET);
    const res = await app.request("/webhook/trend-update", {
      method: "POST",
      headers: { "X-Webhook-Signature": signature },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenants_updated: 3 });
    expect(computeForUser).toHaveBeenCalledTimes(3);
  });
});
