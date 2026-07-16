import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker, { queryNodeLogRows } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

describe("queryNodeLogRows", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function baseEnv() {
    return { CF_ACCOUNT_ID: "acct-1", R2_SQL_TOKEN: "tok-1", R2_BUCKET: "uniscrm-dev", R2_WAREHOUSE: "acct-1_uniscrm-dev" } as any;
  }

  it("queries uniscrm.flow_log filtered by tenant/flow/node/direction=enter, ordered and limited", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ user_id: "u1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");

    expect(rows).toEqual([{ subjectId: "u1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.flow_log");
    expect(body.query).toContain("tenant_id = 42");
    expect(body.query).toContain("flow_id = 'flow-1'");
    expect(body.query).toContain("node_id = 'node-1'");
    expect(body.query).toContain("direction = 'enter'");
    expect(body.query).toContain("ORDER BY created_at DESC");
    expect(body.query).toContain("LIMIT 50");
  });

  it("queries uniscrm.content_flow_log with content_id as the subject column", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ content_id: "c1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.content_flow_log", "content_id", 42, "flow-2", "node-2");

    expect(rows).toEqual([{ subjectId: "c1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.content_flow_log");
  });

  it("returns an empty array when the R2 query is unsuccessful", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");
    expect(rows).toEqual([]);
  });
});

// Handler-level guard: flowId/nodeId route params must look like UUIDs before queryNodeLogRows
// is ever called, since that function interpolates them directly into an R2 SQL string. These
// tests exercise the full Hono route (not queryNodeLogRows directly) to prove a malicious param
// is rejected at the handler boundary — i.e. the R2 query is never issued at all.
describe("GET /api/flows/:id/nodes/:nodeId/logs — UUID validation guard", () => {
  const TENANT_ID = 888;
  const FLOW_ID = "11111111-1111-1111-1111-111111111111";
  const NODE_ID = "22222222-2222-2222-2222-222222222222";
  let fetchMock: ReturnType<typeof vi.fn>;

  function req(path: string) {
    return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
  }

  function r2Calls() {
    return fetchMock.mock.calls.filter((c) => String(c[0]).includes("r2-sql"));
  }

  beforeEach(async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/auth/me")) {
        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
      }
      return mockR2Response([]);
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
      `INSERT INTO tenants (tenant_id, email, d1_database_id, created_at) VALUES (?, 'x@example.com', NULL, datetime('now'))`
    ).bind(TENANT_ID).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES (?, ?, '{"nodes":[],"edges":[]}', 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, TENANT_ID).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.WEB_DB.prepare(`DELETE FROM tenants WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("rejects a SQL-injection-shaped nodeId against a real, tenant-owned flowId without ever querying R2", async () => {
    const maliciousNodeId = "x' OR '1'='1";
    const res = await worker.fetch(req(`/api/flows/${FLOW_ID}/nodes/${encodeURIComponent(maliciousNodeId)}/logs`), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ logs: [] });
    expect(r2Calls()).toHaveLength(0);
  });

  it("rejects a non-UUID flowId without ever querying R2", async () => {
    const res = await worker.fetch(req(`/api/flows/not-a-uuid/nodes/${NODE_ID}/logs`), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ logs: [] });
    expect(r2Calls()).toHaveLength(0);
  });

  it("does not block a legitimate request where both flowId and nodeId are real UUIDs", async () => {
    const res = await worker.fetch(req(`/api/flows/${FLOW_ID}/nodes/${NODE_ID}/logs`), env);
    expect(res.status).toBe(200);
    expect(r2Calls()).toHaveLength(1);
  });
});
