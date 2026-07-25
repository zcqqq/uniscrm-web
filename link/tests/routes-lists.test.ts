import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { listsRoutes } from "../src/routes-lists";

afterEach(() => vi.unstubAllGlobals());

// list_users membership stays in D1 (LINK_DB); only display name/username come from R2 now.
// This fake only needs to answer the two prepared statements GET /:id/users issues.
function fakeLinkDb(listUserRows: { user_id: string; added_at: string }[]) {
  return {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => (sql.startsWith("SELECT COUNT(*)") ? { total: listUserRows.length } : null),
          all: async () => ({ results: sql.startsWith("SELECT user_id") ? listUserRows : [] }),
          run: async () => ({ success: true }),
        }),
      };
    },
  };
}

function appWithTenant(tenantId: number) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tenantId" as never, tenantId); await next(); });
  app.route("/api/lists", listsRoutes());
  return app;
}

const R2_ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_CATALOG_TOKEN: "t" };

describe("GET /api/lists/:id/users", () => {
  it("carries a real username for each member, not null (fix round 1, Important 2)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { rows: [{ id: "u1", name: "Ann", username: "ann_x" }] } }), { status: 200 })
    ));

    const env = { ...R2_ENV, LINK_DB: fakeLinkDb([{ user_id: "u1", added_at: "2026-01-01T00:00:00Z" }]) };
    const res = await appWithTenant(7).request("/api/lists/list1/users", {}, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { users: { id: string; name: string | null; username: string | null }[] };
    expect(body.users).toEqual([{ id: "u1", name: "Ann", username: "ann_x", added_at: "2026-01-01T00:00:00Z" }]);
  });

  it("returns 502 with the R2 error rather than an empty member list when R2 SQL fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "80011: Unauthenticated" }), { status: 401 })
    ));

    const env = { ...R2_ENV, LINK_DB: fakeLinkDb([{ user_id: "u1", added_at: "2026-01-01T00:00:00Z" }]) };
    const res = await appWithTenant(7).request("/api/lists/list1/users", {}, env);

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain("80011");
  });

  // I3: list_users.user_id is a mixed population — a uuid for members added via the UI, an X
  // numeric id for members flow's addToList action added (routes-internal.ts's
  // POST /internal/lists/:id/users writes flow's `userId` verbatim — see r2-entities.ts's
  // getUserDisplayNamesMixed doc comment). Both kinds must resolve a display name in the same
  // response, not just whichever kind happens to match `id`.
  it("resolves both a UI-added (uuid) member and a flow-added (X id) member in the same list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          rows: [
            { id: "uuid-1", source_user_id: "src-1", name: "Ann", username: "ann_x" },
            { id: "uuid-2", source_user_id: "x-42", name: "Bob", username: "bob_x" },
          ],
        },
      }), { status: 200 })
    ));

    const env = {
      ...R2_ENV,
      LINK_DB: fakeLinkDb([
        { user_id: "uuid-1", added_at: "2026-01-01T00:00:00Z" },
        { user_id: "x-42", added_at: "2026-01-02T00:00:00Z" },
      ]),
    };
    const res = await appWithTenant(7).request("/api/lists/list1/users", {}, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { users: { id: string; name: string | null; username: string | null }[] };
    expect(body.users).toEqual([
      { id: "uuid-1", name: "Ann", username: "ann_x", added_at: "2026-01-01T00:00:00Z" },
      { id: "x-42", name: "Bob", username: "bob_x", added_at: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("skips the R2 call entirely (and returns an empty list) when the list has no members", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const env = { ...R2_ENV, LINK_DB: fakeLinkDb([]) };
    const res = await appWithTenant(7).request("/api/lists/list1/users", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ users: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
