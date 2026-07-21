import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { recomputeFlowCounts } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const triggerlessGraph = JSON.stringify({ nodes: [{ id: "a1", type: "action", data: { actionType: "noopLeaf" } }], edges: [] });

async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
       status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
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
}

describe("recomputeFlowCounts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setupSchema();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_counts`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_counts`).run();
    vi.unstubAllGlobals();
  });

  it("issues one query against uniscrm.flow_log and one against uniscrm.content_flow_log", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const queries = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).query);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.flow_log") && q.includes("GROUP BY"))).toBe(true);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.content_flow_log") && q.includes("GROUP BY"))).toBe(true);
  });

  it("upserts flow_counts/content_flow_counts directly into FLOW_DB, overwriting on conflict", async () => {
    fetchMock
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f1", node_id: "n1", direction: "enter", cnt: 5 },
      ]))
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f2", node_id: "n2", direction: "enter", cnt: 3 },
      ]));
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (1, 'f1', 'n1', 'enter', 1, '2020-01-01T00:00:00.000Z')`
    ).run();

    await recomputeFlowCounts(env as any);

    const flowRow = await env.FLOW_DB.prepare(`SELECT tenant_id, count FROM flow_counts WHERE flow_id = 'f1' AND node_id = 'n1' AND direction = 'enter'`).first<{ tenant_id: number; count: number }>();
    expect(flowRow).toMatchObject({ tenant_id: 1, count: 5 });
    const contentRow = await env.FLOW_DB.prepare(`SELECT tenant_id, count FROM content_flow_counts WHERE flow_id = 'f2' AND node_id = 'n2' AND direction = 'enter'`).first<{ tenant_id: number; count: number }>();
    expect(contentRow).toMatchObject({ tenant_id: 1, count: 3 });
  });

  it("caches the trigger node's enter count onto flows.trigger_count for a user-domain flow", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-u1', 1, 'u', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(userFlowGraph).run();
    fetchMock
      .mockResolvedValueOnce(mockR2Response([{ tenant_id: 1, flow_id: "flow-u1", node_id: "t1", direction: "enter", cnt: 42 }]))
      .mockResolvedValueOnce(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-u1'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBe(42);
  });

  it("caches the trigger node's enter count onto flows.trigger_count for a content-domain flow", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-c1', 1, 'c', ?, 'content', 'published', datetime('now'), datetime('now'))`
    ).bind(contentFlowGraph).run();
    fetchMock
      .mockResolvedValueOnce(mockR2Response([]))
      .mockResolvedValueOnce(mockR2Response([{ tenant_id: 1, flow_id: "flow-c1", node_id: "t1", direction: "enter", cnt: 7 }]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-c1'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBe(7);
  });

  it("leaves trigger_count NULL for a flow with no recognized trigger node", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-none', 1, 'n', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(triggerlessGraph).run();
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-none'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBeNull();
  });

  it("leaves trigger_count NULL for a flow whose trigger node has no R2 activity yet", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-quiet', 1, 'q', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(userFlowGraph).run();
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-quiet'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBeNull();
  });
});
