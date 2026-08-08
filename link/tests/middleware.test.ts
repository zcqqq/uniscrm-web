import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";

// Spy on TenantDataDB's constructor so we can assert exactly which
// (accountId, apiToken, dbId) triple the middleware passes it — not just
// that "something" got set on the context.
const tenantDataDbCtorMock = vi.fn();
vi.mock("../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    constructor(...args: unknown[]) {
      tenantDataDbCtorMock(...args);
    }
  },
}));

import { authMiddleware } from "../src/middleware";
import { EntityStateStore } from "../src/services/entity-state";

afterEach(() => {
  tenantDataDbCtorMock.mockClear();
  vi.unstubAllGlobals();
});

function buildApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/probe", (c) => {
    const tenantDataDb = c.get("tenantDataDb" as never);
    const entityState = c.get("entityState" as never);
    return c.json({
      tenantId: c.get("tenantId" as never),
      email: c.get("email" as never),
      tenantDataDbSet: tenantDataDb !== undefined,
      entityStateIsStore: entityState instanceof EntityStateStore,
    });
  });
  return app;
}

const sessionCookie = { headers: { Cookie: "session=sess-1" } };

// authMiddleware now resolves sessions via shared/auth.ts (D1 only — the old KV-first
// branch was dead code and is gone), then looks up tenants.d1_database_id. Dispatch the
// fake WEB_DB on the SQL text so each query gets its own row.
function fakeWebDb(opts: {
  sessionRow: { member_id: string; tenant_id: number; email: string; language: string } | null;
  tenantRow: { d1_database_id: string | null } | null;
}) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes("FROM sessions")) return opts.sessionRow;
          if (sql.includes("FROM tenants")) return opts.tenantRow;
          throw new Error(`unexpected WEB_DB query in test: ${sql}`);
        }),
      })),
    })),
  };
}

const validSession = { member_id: "m1", tenant_id: 42, email: "a@b.c", language: "en" };

const ENV_BASE = {
  CF_ACCOUNT_ID: "acct-123",
  CF_D1_API_TOKEN: "tok-456",
  LINK_DB: {},
};

describe("authMiddleware", () => {
  it("injects tenantDataDb (right ctor args) and keeps entityState set when the tenant is provisioned", async () => {
    const webDb = fakeWebDb({ sessionRow: validSession, tenantRow: { d1_database_id: "db-provisioned-1" } });

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenantId: 42,
      // Real email from the sessions row — the deleted KV-less D1 branch used to stub "".
      email: "a@b.c",
      tenantDataDbSet: true,
      entityStateIsStore: true,
    });
    expect(tenantDataDbCtorMock).toHaveBeenCalledTimes(1);
    expect(tenantDataDbCtorMock).toHaveBeenCalledWith("acct-123", "tok-456", "db-provisioned-1");
  });

  it("does not inject tenantDataDb when d1_database_id is null, but still sets entityState", async () => {
    const webDb = fakeWebDb({ sessionRow: validSession, tenantRow: { d1_database_id: null } });

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 42, email: "a@b.c", tenantDataDbSet: false, entityStateIsStore: true });
    expect(tenantDataDbCtorMock).not.toHaveBeenCalled();
  });

  it("does not inject tenantDataDb when the tenant has no row at all, but still sets entityState", async () => {
    const webDb = fakeWebDb({ sessionRow: validSession, tenantRow: null });

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 42, email: "a@b.c", tenantDataDbSet: false, entityStateIsStore: true });
    expect(tenantDataDbCtorMock).not.toHaveBeenCalled();
  });

  it("returns 401 without a session cookie", async () => {
    const webDb = fakeWebDb({ sessionRow: validSession, tenantRow: null });
    const res = await buildApp().request("/probe", {}, { ...ENV_BASE, WEB_DB: webDb } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the sessions row is missing or expired (SQL-side expiry)", async () => {
    const webDb = fakeWebDb({ sessionRow: null, tenantRow: { d1_database_id: "db-1" } });
    const res = await buildApp().request("/probe", sessionCookie, { ...ENV_BASE, WEB_DB: webDb } as never);
    expect(res.status).toBe(401);
    expect(tenantDataDbCtorMock).not.toHaveBeenCalled();
  });
});
