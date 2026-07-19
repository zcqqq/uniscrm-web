import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const graphWithWait = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "minutes" }, position: { x: 200, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "w1" },
    { id: "e2", source: "w1", target: "a1" },
  ],
});

describe("scheduled(): content_flow_pending sweep", () => {
  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory (no
    // <BINDING>_MIGRATIONS binding is wired up — confirmed empirically by Task 5's
    // flow/tests/unit/queue-content.test.ts). Create the post-migration schema by hand,
    // matching migrations/0001_init.sql (as amended by 0011_drop_enabled.sql, which removed
    // flows.enabled) and migrations/0013_content_flow_tables.sql. Copied from
    // queue-content.test.ts's beforeEach to avoid a second, independently-drifting copy of the
    // same schema.
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
    // scheduled() unconditionally queries flow_pending before reaching the content sweep
    // (untouched, pre-existing code this task must not modify) — the table must exist or that
    // query throws "no such table: flow_pending" before the content_flow_pending sweep ever runs.
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_pending (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         node_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         payload TEXT NOT NULL,
         execute_at TEXT NOT NULL,
         awaiting_event TEXT NOT NULL DEFAULT '',
         conditions TEXT NOT NULL DEFAULT '',
         retry_action TEXT NOT NULL DEFAULT '',
         retry_count INTEGER NOT NULL DEFAULT 0,
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
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_pending (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         node_id TEXT NOT NULL,
         content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         payload TEXT NOT NULL,
         execute_at TEXT NOT NULL,
         awaiting_event TEXT NOT NULL DEFAULT '',
         conditions TEXT NOT NULL DEFAULT '',
         retry_action TEXT NOT NULL DEFAULT '',
         retry_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL
       )`
    ).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-c2'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-c2'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-c2'`).run();
  });

  it("resumes a due content_flow_pending row via resumeFromNode and clears it", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-c2', 1, 'content wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithWait).run();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at)
       VALUES ('pend-1', 'flow-c2', 'w1', 'content-abc', 1, '{}', ?, datetime('now'))`
    ).bind(past).run();

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-1'`).first();
    expect(remaining).toBeNull();

    const exec = await env.FLOW_DB.prepare(
      `SELECT content_id FROM content_flow_executions WHERE flow_id = 'flow-c2'`
    ).first<{ content_id: string }>();
    expect(exec).toMatchObject({ content_id: "content-abc" });
  });
});

describe("scheduled(): content_flow_pending retry_action handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-retry1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-retry1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-retry1'`).run();
    vi.unstubAllGlobals();
  });

  const graphWithBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", prompt: "Rewrite: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });

  it("re-attempts a rate-limited retry_action row and reschedules it again if still rate-limited", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-retry1', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "xContentAction", nodeId: "a1", hasBranches: true, prompt: "Rewrite: $content.content_text", provider: "default" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retry-1', 'flow-retry1', '', 'content-retry-1', 1, '{}', ?, datetime('now'), ?, 0)`
    ).bind(past, JSON.stringify(action)).run();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    await worker.scheduled({} as any, env);

    const row = await env.FLOW_DB.prepare(`SELECT retry_count, execute_at FROM content_flow_pending WHERE id = 'pend-retry-1'`).first<{ retry_count: number; execute_at: string }>();
    expect(row?.retry_count).toBe(1);
    expect(row?.execute_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("resolves the branch and clears the row once no longer rate-limited", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-retry1', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "xContentAction", nodeId: "a1", hasBranches: true, prompt: "Rewrite: $content.content_text", provider: "default" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retry-2', 'flow-retry1', '', 'content-retry-2', 1, '{}', ?, datetime('now'), ?, 2)`
    ).bind(past, JSON.stringify(action)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-retry-2'`).first();
    expect(remaining).toBeNull();

    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-retry1' AND content_id = 'content-retry-2'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });

  it("resolves the failed branch once rate-limit retries are exhausted (retry_count >= 5)", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-retry1', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "xContentAction", nodeId: "a1", hasBranches: true, prompt: "Rewrite: $content.content_text", provider: "default" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retry-3', 'flow-retry1', '', 'content-retry-3', 1, '{}', ?, datetime('now'), ?, 5)`
    ).bind(past, JSON.stringify(action)).run();

    // Still rate-limited on this final attempt too — retry_count (5) is no longer < 5, so this
    // must exhaust and resolve the "failed" branch (a3: noopLeaf), not just silently delete the row.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-retry-3'`).first();
    expect(remaining).toBeNull();

    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-retry1' AND content_id = 'content-retry-3'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });
});
