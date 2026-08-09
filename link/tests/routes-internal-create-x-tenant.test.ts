import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { internalRoutes } from "../src/routes-internal";

// /internal/channels/create-x is the system-app (X sign-in) path. Its upsert carries
// `ON CONFLICT(...) DO UPDATE SET ... tenant_id = excluded.tenant_id`, so before the guard a
// second tenant signing in with an X account another tenant already held silently MOVED the
// channel — and every event the shared webhook attributes through it — into the newcomer.

const X_USER_ID = "3245609912";

function mockLinkDb(holder: { id: string; tenant_id: number | null } | null) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          first: async () => {
            if (sql.includes("SELECT id, tenant_id FROM channels")) return holder;
            if (sql.includes("SELECT id FROM channels")) return { id: holder?.id ?? "new-chan" };
            return null;
          },
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        };
      },
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

const webDb = {
  prepare: () => ({ bind: () => ({ first: async () => ({ email: "owner@example.com" }) }) }),
} as unknown as D1Database;

function buildApp() {
  const app = new Hono();
  app.route("/internal", internalRoutes());
  return app;
}

function createX(app: Hono, env: unknown, tenantId: number) {
  return app.request("/internal/channels/create-x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": "s3cret" },
    body: JSON.stringify({ tenant_id: tenantId, member_id: "m1", access_token: "at", refresh_token: "rt", expires_at: "2026-01-01T00:00:00Z" }),
  }, env as never);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { id: X_USER_ID, name: "N", username: "u" } }), { status: 200 })
  ));
});

describe("POST /internal/channels/create-x — cross-tenant takeover", () => {
  it("refuses when another tenant already holds the X account, and writes nothing", async () => {
    const { db, calls } = mockLinkDb({ id: "held-chan", tenant_id: 999 });
    const res = await createX(buildApp(), { LINK_DB: db, WEB_DB: webDb, INTERNAL_SECRET: "s3cret" }, 5);

    expect(res.status).toBe(409);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("#999");
    expect(body.error).toContain("o****@example.com");
    expect(calls.some((c) => c.sql.includes("INSERT INTO channels"))).toBe(false);
  });

  it("lets the holding tenant itself re-sign-in (reactivates its own row)", async () => {
    const { db, calls } = mockLinkDb({ id: "held-chan", tenant_id: 5 });
    const res = await createX(buildApp(), { LINK_DB: db, WEB_DB: webDb, INTERNAL_SECRET: "s3cret" }, 5);

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.sql.includes("INSERT INTO channels"))).toBe(true);
  });

  it("creates the channel when nobody holds the account", async () => {
    const { db, calls } = mockLinkDb(null);
    const res = await createX(buildApp(), { LINK_DB: db, WEB_DB: webDb, INTERNAL_SECRET: "s3cret" }, 5);

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.sql.includes("INSERT INTO channels"))).toBe(true);
  });

  // A tier-paused channel still owns its account, so is_active is deliberately not part of
  // the holder lookup — otherwise a pause would open a window for another tenant to claim it.
  it("refuses even when the holding row is a tenant-less orphan", async () => {
    const { db, calls } = mockLinkDb({ id: "held-chan", tenant_id: null });
    const res = await createX(buildApp(), { LINK_DB: db, WEB_DB: webDb, INTERNAL_SECRET: "s3cret" }, 5);

    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain("unassigned");
    expect(calls.some((c) => c.sql.includes("INSERT INTO channels"))).toBe(false);
  });
});
