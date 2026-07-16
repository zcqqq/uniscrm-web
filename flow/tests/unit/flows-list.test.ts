import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 999;

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

// GET /api/flows is behind authMiddleware, which calls WEB_URL's /api/auth/me over fetch
// and c.set()s tenantId/memberId from the response. We stub global fetch so that call
// resolves to a fixed tenant/member, matching the tenant_id used by the fixture rows below,
// then call the real worker.fetch(...) so this test actually exercises flow/src/index.ts's
// GET /api/flows domain-filter SQL rather than re-implementing/hardcoding it here.
describe("GET /api/flows domain filter", () => {
  beforeEach(async () => {
    // authMiddleware runs for both the "/api/flows" and "/api/flows/*" registrations, which
    // both match this path and so invoke the mocked fetch (and read its body) more than once
    // per request -- return a fresh Response each call rather than a single shared instance.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 })
      )
    );

    // vitest-pool-workers does not auto-apply this module's migrations/ directory (see
    // queue-content.test.ts beforeEach for the same note) -- create the post-migration
    // `flows` table by hand, matching migrations/0001_init.sql as amended by
    // 0011_drop_enabled.sql (which removed flows.enabled).
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY,
         tenant_id INTEGER NOT NULL,
         member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow',
         description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
         status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_executions (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         event_id TEXT,
         user_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         matched INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_executions (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         event_id TEXT,
         content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         matched INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL
       )`
    ).run();

    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at) VALUES ('f-user', ?, 'u', ?, 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at) VALUES ('f-content', ?, 'c', ?, 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentFlowGraph),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("domain=content returns only the xContentTrigger flow", async () => {
    const res = await worker.fetch(req("/api/flows?domain=content"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string }[] };
    expect(body.flows.map((f) => f.id)).toEqual(["f-content"]);
  });

  it("domain=user (default) returns only the non-xContentTrigger flow", async () => {
    const res = await worker.fetch(req("/api/flows"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string }[] };
    expect(body.flows.map((f) => f.id)).toEqual(["f-user"]);
  });
});
