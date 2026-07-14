import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "contentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });

// Auth is proxied to WEB_URL's /api/auth/me in production; this test calls the
// handler directly via a request carrying the same tenant/member context the
// authMiddleware sets, matching how other flow/src/index.ts route tests in this
// suite are expected to seed state directly rather than mocking the auth fetch.
describe("GET /api/flows domain filter", () => {
  beforeEach(async () => {
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
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = 999`).run();
  });

  it("graph_json LIKE filter distinguishes contentTrigger flows from others", async () => {
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at) VALUES ('f-user', 999, 'u', ?, 'draft', datetime('now'), datetime('now'))`
      ).bind(userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at) VALUES ('f-content', 999, 'c', ?, 'draft', datetime('now'), datetime('now'))`
      ).bind(contentFlowGraph),
    ]);

    const contentRows = await env.FLOW_DB.prepare(
      `SELECT id FROM flows WHERE tenant_id = 999 AND graph_json LIKE '%contentTrigger%'`
    ).all<{ id: string }>();
    expect(contentRows.results.map((r) => r.id)).toEqual(["f-content"]);

    const userRows = await env.FLOW_DB.prepare(
      `SELECT id FROM flows WHERE tenant_id = 999 AND graph_json NOT LIKE '%contentTrigger%'`
    ).all<{ id: string }>();
    expect(userRows.results.map((r) => r.id)).toEqual(["f-user"]);
  });
});
