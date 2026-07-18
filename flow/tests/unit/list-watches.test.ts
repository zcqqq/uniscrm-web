import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const INTERNAL_SECRET = (env as any).INTERNAL_SECRET || "test-secret";

function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://flow.test${path}`, { headers: { "X-Internal-Secret": INTERNAL_SECRET, ...headers } });
}

describe("GET /internal/list-watches", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id LIKE 'lw-%'`).run();
  });

  it("returns 401 without a valid X-Internal-Secret", async () => {
    const res = await worker.fetch(new Request("https://flow.test/internal/list-watches"), env);
    expect(res.status).toBe(401);
  });

  it("returns distinct channelId/listId pairs from published xContentTrigger List Posts nodes", async () => {
    const graph1 = JSON.stringify({
      nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "get-list-posts", listId: "listA" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const graph2 = JSON.stringify({
      nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "get-list-posts", listId: "listA" }, position: { x: 0, y: 0 } }],
      edges: [],
    }); // duplicate pair — must be deduped
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-1', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(graph1),
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-2', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(graph2),
    ]);

    const res = await worker.fetch(req("/internal/list-watches"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { watches: { channelId: string; listId: string }[] };
    expect(body.watches).toEqual([{ channelId: "chan1", listId: "listA" }]);
  });

  it("ignores My Posts mode nodes and draft flows", async () => {
    const myPostsGraph = JSON.stringify({
      nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "chan2", mode: "own:get-posts" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const draftGraph = JSON.stringify({
      nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "chan3", mode: "get-list-posts", listId: "listB" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-3', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(myPostsGraph),
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-4', 1, ?, 'draft', datetime('now'), datetime('now'))`).bind(draftGraph),
    ]);

    const res = await worker.fetch(req("/internal/list-watches"), env);
    const body = await res.json() as { watches: { channelId: string; listId: string }[] };
    expect(body.watches).toEqual([]);
  });

  it("skips malformed graph_json rows (valid JSON but missing/wrong shape) instead of crashing", async () => {
    // Valid row to ensure we still get results from other rows
    const validGraph = JSON.stringify({
      nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "get-list-posts", listId: "listA" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    // Malformed: valid JSON but no `nodes` key (yet contains xContentTrigger to pass SQL LIKE filter)
    const malformedGraph1 = JSON.stringify({
      edges: [],
      note: "contains xContentTrigger string but no nodes array",
    });
    // Malformed: valid JSON but nodes is not an array
    const malformedGraph2 = JSON.stringify({
      nodes: { id: "invalid" },
      note: "xContentTrigger nodes should be an array",
    });
    // Valid row with node.data = null (should skip that node but not crash)
    const nodeNullDataGraph = JSON.stringify({
      nodes: [{ id: "bad-node", type: "xContentTrigger", data: null, position: { x: 0, y: 0 } }],
      edges: [],
    });

    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-valid', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(validGraph),
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-bad-1', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(malformedGraph1),
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-bad-2', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(malformedGraph2),
      env.FLOW_DB.prepare(`INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('lw-null-data', 1, ?, 'published', datetime('now'), datetime('now'))`).bind(nodeNullDataGraph),
    ]);

    const res = await worker.fetch(req("/internal/list-watches"), env);
    // Should return 200, not 500, despite malformed rows
    expect(res.status).toBe(200);
    const body = await res.json() as { watches: { channelId: string; listId: string }[] };
    // Only the valid row should appear
    expect(body.watches).toEqual([{ channelId: "chan1", listId: "listA" }]);
  });
});
