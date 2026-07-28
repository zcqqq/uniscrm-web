import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { internalRoutes } from "../src/routes-internal";
import type { Env } from "../src/types";

interface FakeRow { id: string; tenant_id: number; is_active: number }

// Row-store fake that honours the WHERE clause the route actually sends, so a query that
// forgets `tenant_id = ?` or `is_active = 1` really does see the wrong rows instead of
// silently passing.
function createMockLinkDb(rows: FakeRow[]) {
  const stmt = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    all: async () => {
      let match = rows;
      if (sql.includes("tenant_id = ?")) match = match.filter((r) => r.tenant_id === Number(args[0]));
      if (sql.includes("is_active = 1")) match = match.filter((r) => r.is_active === 1);
      return { results: match.map((r) => ({ id: r.id })) };
    },
  });
  return { prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database;
}

function app(db: D1Database) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/internal", internalRoutes());
  return (path: string) => a.fetch(new Request(`https://link.test${path}`), { LINK_DB: db } as unknown as Env);
}

describe("GET /internal/channels/active", () => {
  it("returns only this tenant's active channel ids", async () => {
    const fetchApp = app(createMockLinkDb([
      { id: "c-mine-live", tenant_id: 1, is_active: 1 },
      { id: "c-mine-dead", tenant_id: 1, is_active: 0 },
      { id: "c-other-live", tenant_id: 2, is_active: 1 },
    ]));
    const res = await fetchApp("/internal/channels/active?tenantId=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelIds: ["c-mine-live"] });
  });

  it("returns an empty list for a tenant with no active channels", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-dead", tenant_id: 1, is_active: 0 }]));
    const res = await fetchApp("/internal/channels/active?tenantId=1");
    expect(await res.json()).toEqual({ channelIds: [] });
  });

  it("rejects a missing tenantId rather than leaking every tenant's channels", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-live", tenant_id: 1, is_active: 1 }]));
    const res = await fetchApp("/internal/channels/active");
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric tenantId", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-live", tenant_id: 1, is_active: 1 }]));
    const res = await fetchApp("/internal/channels/active?tenantId=abc");
    expect(res.status).toBe(400);
  });
});
