import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 777;

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const youtubeContentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "youtubeContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
// Regression fixture: a content flow whose only trigger was deleted. Domain now comes from the
// flows.domain column (migration 0014), so the graph having no trigger at all must not send this
// flow's analytics to the user-domain flow_counts table.
const triggerlessGraph = JSON.stringify({ nodes: [{ id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 0, y: 0 } }], edges: [] });

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

describe("GET /api/flows/:id/analytics", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (url: string) => {
      return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft',
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
        `INSERT INTO flows (id, tenant_id, graph_json, domain, status, created_at, updated_at) VALUES ('flow-an-user', ?, ?, 'user', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, domain, status, created_at, updated_at) VALUES ('flow-an-content', ?, ?, 'content', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, domain, status, created_at, updated_at) VALUES ('flow-an-youtube', ?, ?, 'content', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, youtubeContentFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, domain, status, created_at, updated_at) VALUES ('flow-an-triggerless', ?, ?, 'content', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, triggerlessGraph),
    ]);

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_counts (
         tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
         count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_counts (
         tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
         count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
       )`
    ).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, 'flow-an-user', 't1', 'enter', 9, datetime('now'))`
      ).bind(TENANT_ID),
      env.FLOW_DB.prepare(
        `INSERT INTO content_flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, 'flow-an-content', 't1', 'enter', 4, datetime('now'))`
      ).bind(TENANT_ID),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_counts WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_counts WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.WEB_DB.prepare(`DELETE FROM tenants WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("returns the cached flow_counts row for a user-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-user/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, { enter: number; exit: number }> };
    expect(body.nodes).toEqual({ t1: { enter: 9, exit: 0 } });
  });

  it("returns the cached content_flow_counts row for a content-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-content/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, { enter: number; exit: number }> };
    expect(body.nodes).toEqual({ t1: { enter: 4, exit: 0 } });
  });

  it("queries content_flow_counts for a YouTube-only content flow (no xContentTrigger substring)", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-youtube/analytics"), env);
    expect(res.status).toBe(200);
    // No seeded rows for this flow -- empty nodes is still a 200, proving it read
    // content_flow_counts (not flow_counts) without erroring.
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });

  it("queries content_flow_counts for a content flow whose only trigger was deleted", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-triggerless/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });

  it("returns { nodes: {} } for a flow id that doesn't exist for this tenant", async () => {
    const res = await worker.fetch(req("/api/flows/flow-nonexistent/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });
});
