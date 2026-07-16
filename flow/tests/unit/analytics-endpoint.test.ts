import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 777;

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

function d1QueryResponse(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: [{ results: rows, success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }), { status: 200 });
}

describe("GET /api/flows/:id/analytics", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/auth/me")) {
        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
      }
      // Tenant D1 REST query — the specific rows returned don't matter for this task's
      // table-selection assertions, an empty result set is enough.
      return d1QueryResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.WEB_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
         tenant_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
         d1_database_id TEXT, created_at TEXT NOT NULL
       )`
    ).run();
    await env.WEB_DB.prepare(
      `INSERT INTO tenants (tenant_id, email, d1_database_id, created_at) VALUES (?, 'x@example.com', 'tenant-db-1', datetime('now'))`
    ).bind(TENANT_ID).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('flow-an-user', ?, ?, 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('flow-an-content', ?, ?, 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentFlowGraph),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.WEB_DB.prepare(`DELETE FROM tenants WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("queries content_flow_counts for a flow whose graph_json contains xContentTrigger", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-content/analytics"), env);
    expect(res.status).toBe(200);
    const d1Call = fetchMock.mock.calls.find((c) => !String(c[0]).includes("/api/auth/me"));
    const body = JSON.parse(d1Call![1].body as string);
    expect(body.sql).toContain("FROM content_flow_counts");
  });

  it("queries flow_counts for a flow without xContentTrigger", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-user/analytics"), env);
    expect(res.status).toBe(200);
    const d1Call = fetchMock.mock.calls.find((c) => !String(c[0]).includes("/api/auth/me"));
    const body = JSON.parse(d1Call![1].body as string);
    expect(body.sql).toContain("FROM flow_counts");
  });

  it("returns { nodes: {} } for a flow id that doesn't exist for this tenant", async () => {
    const res = await worker.fetch(req("/api/flows/flow-nonexistent/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });
});
