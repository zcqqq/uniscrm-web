import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";
import type { Env } from "../src/types";

interface FakeRow {
  id: string;
  channel_type: string;
  config: string;
  tenant_id: number;
  is_byok: number;
  is_active: number;
  created_at: string;
}

// Row-store fake that honours whatever WHERE clause the route actually sends.
// The tenant predicate is applied only when the SQL asks for it, so a query
// that forgets `tenant_id = ?` really does see every tenant's rows — which is
// what makes these tests fail against unscoped code instead of silently passing.
function createMockLinkDb(rows: FakeRow[]) {
  const isXStatusQuery = (sql: string) =>
    sql.includes("SELECT id, config, created_at FROM channels") && sql.includes("is_byok = 0 OR is_byok IS NULL");
  const isByokProbeQuery = (sql: string) =>
    sql.includes("SELECT id FROM channels") && sql.includes("is_byok = 1") && sql.includes("LIMIT 1");
  const isDisconnectAll = (sql: string) =>
    sql.startsWith("UPDATE channels SET is_active = 0") && sql.includes("channel_type IN ('TWITTER', 'X')");

  // These three statements carry no placeholder other than the tenant one, so
  // when scoping is present the tenant id is always the first bound value.
  const scoped = (sql: string, args: unknown[], candidates: FakeRow[]) =>
    sql.includes("tenant_id = ?") ? candidates.filter((r) => r.tenant_id === args[0]) : candidates;

  const run = (sql: string, args: unknown[]) => {
    if (isXStatusQuery(sql)) {
      const match = scoped(sql, args, rows.filter((r) => ["TWITTER", "X"].includes(r.channel_type) && r.is_active === 1 && !r.is_byok));
      return { first: match[0] ?? null, changes: 0 };
    }
    if (isByokProbeQuery(sql)) {
      const match = scoped(sql, args, rows.filter((r) => r.channel_type === "X" && r.is_active === 1 && r.is_byok === 1));
      return { first: match[0] ? { id: match[0].id } : null, changes: 0 };
    }
    if (isDisconnectAll(sql)) {
      const nonByokOnly = sql.includes("is_byok = 0 OR is_byok IS NULL");
      const match = scoped(sql, args, rows.filter((r) =>
        ["TWITTER", "X"].includes(r.channel_type) && r.is_active === 1 && (!nonByokOnly || !r.is_byok)
      ));
      for (const r of match) r.is_active = 0;
      return { first: null, changes: match.length };
    }
    return { first: null, changes: 0 };
  };

  const stmt = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    first: async <T>() => run(sql, args).first as T | null,
    run: async () => ({ success: true, meta: { changes: run(sql, args).changes } }),
  });

  return { prepare: (sql: string) => stmt(sql, []) };
}

function buildApp(linkDb: ReturnType<typeof createMockLinkDb>, tenantId: number) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, tenantId as never);
    c.set("memberId" as never, `member-${tenantId}` as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return (path: string, init?: RequestInit) =>
    app.request(path, init, { LINK_DB: linkDb } as unknown as Env);
}

// Mirrors the production row that surfaced this bug: tenant 100001 had an
// active non-BYOK X channel, tenant 1 had none, and tenant 1's channel page
// showed tenant 100001's @handle.
const otherTenantsX: FakeRow = {
  id: "other-tenant-x",
  channel_type: "X",
  config: JSON.stringify({ x_username: "alwayszhang" }),
  tenant_id: 100001,
  is_byok: 0,
  is_active: 1,
  created_at: "2026-07-20 05:35:31",
};

describe("GET /api/channels/x/status tenant isolation", () => {
  it("does not report another tenant's X connection as ours", async () => {
    const request = buildApp(createMockLinkDb([{ ...otherTenantsX }]), 1);

    const res = await request("/api/channels/x/status");
    const body = await res.json() as { connected: boolean; username?: string };

    expect(body.connected).toBe(false);
    expect(body.username).toBeUndefined();
  });

  it("still reports our own X connection", async () => {
    const ownRow: FakeRow = { ...otherTenantsX, id: "own-x", tenant_id: 1, config: JSON.stringify({ x_username: "uniscrm" }) };
    const request = buildApp(createMockLinkDb([{ ...otherTenantsX }, ownRow]), 1);

    const res = await request("/api/channels/x/status");
    const body = await res.json() as { connected: boolean; username?: string; channel_id?: string };

    expect(body.connected).toBe(true);
    expect(body.username).toBe("uniscrm");
    expect(body.channel_id).toBe("own-x");
  });

  it("does not report another tenant's BYOK app via has_byok", async () => {
    const otherByok: FakeRow = { ...otherTenantsX, id: "other-byok", is_byok: 1 };
    const request = buildApp(createMockLinkDb([otherByok]), 1);

    const res = await request("/api/channels/x/status");
    const body = await res.json() as { has_byok: boolean };

    expect(body.has_byok).toBe(false);
  });
});

describe("DELETE /api/channels/x tenant isolation", () => {
  it("leaves other tenants' X channels connected", async () => {
    const ownRow: FakeRow = { ...otherTenantsX, id: "own-x", tenant_id: 1 };
    const theirRow: FakeRow = { ...otherTenantsX };
    const request = buildApp(createMockLinkDb([ownRow, theirRow]), 1);

    const res = await request("/api/channels/x", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(ownRow.is_active).toBe(0);
    expect(theirRow.is_active).toBe(1);
  });

  // The X card and each X (BYOK) card are separate cards with separate
  // disconnect buttons — disconnecting the system app must not take the
  // tenant's own BYOK apps down with it.
  it("leaves our own BYOK apps connected", async () => {
    const systemRow: FakeRow = { ...otherTenantsX, id: "own-x", tenant_id: 1 };
    const byokRow: FakeRow = { ...otherTenantsX, id: "own-byok", tenant_id: 1, is_byok: 1 };
    const request = buildApp(createMockLinkDb([systemRow, byokRow]), 1);

    await request("/api/channels/x", { method: "DELETE" });

    expect(systemRow.is_active).toBe(0);
    expect(byokRow.is_active).toBe(1);
  });
});
