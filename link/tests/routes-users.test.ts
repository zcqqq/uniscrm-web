import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { usersRoutes } from "../src/routes-users";

afterEach(() => vi.unstubAllGlobals());

function appWithTenant(tenantId: number) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tenantId" as never, tenantId); await next(); });
  app.route("/api/users", usersRoutes());
  return app;
}

const ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };

it("lists users from R2 scoped to the caller's tenant", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows: [{ id: "u1", name: "Ann" }] } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  const res = await appWithTenant(7).request("/api/users", {}, ENV);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ users: [{ id: "u1", name: "Ann" }] });
  const q = JSON.parse(fetchMock.mock.calls[0][1].body as string).query as string;
  expect(q).toContain("tenant_id = 7");
});

it("returns 502 with the R2 error rather than an empty list when R2 SQL fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "80011: Unauthenticated" }), { status: 401 })
  ));

  const res = await appWithTenant(7).request("/api/users", {}, ENV);

  expect(res.status).toBe(502);
  expect(JSON.stringify(await res.json())).toContain("80011");
});

it("no longer exposes the per-user detail route", async () => {
  const res = await appWithTenant(7).request("/api/users/u1", {}, ENV);
  expect(res.status).toBe(404);
});
