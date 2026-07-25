import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// The node-logs route (GET /api/flows/:id/nodes/:nodeId/logs) interpolates a node id directly
// into an R2 SQL string, guarded by a [A-Za-z0-9_-]{1,64} allowlist. That guard is only a
// backstop if a flow's own graph_json can never contain a node id outside that shape in the
// first place — these tests enforce the invariant at the boundary where graph_json is written,
// so the read-side guard never has to reject a *legitimate* id (e.g. a future AI-generated flow
// that doesn't stick to the "UUID format" the LLM prompt merely asks for).
const TENANT_ID = 777;

function req(path: string, init?: RequestInit) {
  return new Request(`https://flow.test${path}`, {
    ...init,
    headers: { Cookie: "session=test", "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

function graphWith(nodeId: string) {
  return JSON.stringify({ nodes: [{ id: nodeId, type: "action", data: {}, position: { x: 0, y: 0 } }], edges: [] });
}

describe("graph_json node id validation on save", () => {
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 })
      )
    );

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("rejects a POST whose graph_json has a SQL-injection-shaped node id", async () => {
    const res = await worker.fetch(
      req("/api/flows", { method: "POST", body: JSON.stringify({ name: "n", graph_json: graphWith("x' OR '1'='1") }) }),
      env
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("x' OR '1'='1");

    const row = await env.FLOW_DB.prepare(`SELECT id FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).first();
    expect(row).toBeNull();
  });

  it("accepts a POST whose graph_json uses a template-style short node id", async () => {
    const res = await worker.fetch(
      req("/api/flows", { method: "POST", body: JSON.stringify({ name: "n", graph_json: graphWith("t1") }) }),
      env
    );
    expect(res.status).toBe(201);
  });

  it("accepts a POST whose graph_json uses a crypto.randomUUID()-style node id", async () => {
    const res = await worker.fetch(
      req("/api/flows", {
        method: "POST",
        body: JSON.stringify({ name: "n", graph_json: graphWith("a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6") }),
      }),
      env
    );
    expect(res.status).toBe(201);
  });

  it("rejects a PUT that would introduce a non-conforming node id, leaving the stored graph untouched", async () => {
    const now = new Date().toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, graph_json, created_at, updated_at) VALUES ('f-1', ?, ?, ?, ?)`
    ).bind(TENANT_ID, graphWith("t1"), now, now).run();

    const res = await worker.fetch(
      req("/api/flows/f-1", { method: "PUT", body: JSON.stringify({ graph_json: graphWith("bad id with spaces") }) }),
      env
    );
    expect(res.status).toBe(400);

    const row = await env.FLOW_DB.prepare(`SELECT graph_json FROM flows WHERE id = 'f-1'`).first<{ graph_json: string }>();
    expect(row?.graph_json).toBe(graphWith("t1"));
  });

  it("accepts a PUT whose graph_json node ids all conform", async () => {
    const now = new Date().toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, graph_json, created_at, updated_at) VALUES ('f-2', ?, ?, ?, ?)`
    ).bind(TENANT_ID, graphWith("t1"), now, now).run();

    const res = await worker.fetch(
      req("/api/flows/f-2", { method: "PUT", body: JSON.stringify({ graph_json: graphWith("a2") }) }),
      env
    );
    expect(res.status).toBe(200);

    const row = await env.FLOW_DB.prepare(`SELECT graph_json FROM flows WHERE id = 'f-2'`).first<{ graph_json: string }>();
    expect(row?.graph_json).toBe(graphWith("a2"));
  });
});
