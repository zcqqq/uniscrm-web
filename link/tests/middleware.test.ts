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
      tenantDataDbSet: tenantDataDb !== undefined,
      entityStateIsStore: entityState instanceof EntityStateStore,
    });
  });
  return app;
}

const sessionCookie = { headers: { Cookie: "session=sess-1" } };

function kvWithSession(tenantId: number) {
  return {
    get: vi.fn().mockResolvedValue(JSON.stringify({ tenant_id: tenantId, member_id: "m1", email: "a@b.c" })),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

function webDbReturningTenantRow(row: { d1_database_id: string | null } | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(row),
      }),
    }),
  };
}

const ENV_BASE = {
  CF_ACCOUNT_ID: "acct-123",
  CF_D1_API_TOKEN: "tok-456",
  LINK_DB: {},
};

describe("authMiddleware", () => {
  it("injects tenantDataDb (right ctor args) and keeps entityState set when the tenant is provisioned", async () => {
    const kv = kvWithSession(42);
    const webDb = webDbReturningTenantRow({ d1_database_id: "db-provisioned-1" });

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, KV: kv, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantDataDbSet: true, entityStateIsStore: true });
    expect(tenantDataDbCtorMock).toHaveBeenCalledTimes(1);
    expect(tenantDataDbCtorMock).toHaveBeenCalledWith("acct-123", "tok-456", "db-provisioned-1");
  });

  it("does not inject tenantDataDb when d1_database_id is null, but still sets entityState", async () => {
    const kv = kvWithSession(42);
    const webDb = webDbReturningTenantRow({ d1_database_id: null });

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, KV: kv, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantDataDbSet: false, entityStateIsStore: true });
    expect(tenantDataDbCtorMock).not.toHaveBeenCalled();
  });

  it("does not inject tenantDataDb when the tenant has no row at all, but still sets entityState", async () => {
    const kv = kvWithSession(42);
    const webDb = webDbReturningTenantRow(null);

    const res = await buildApp().request(
      "/probe",
      sessionCookie,
      { ...ENV_BASE, KV: kv, WEB_DB: webDb } as never
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantDataDbSet: false, entityStateIsStore: true });
    expect(tenantDataDbCtorMock).not.toHaveBeenCalled();
  });
});
