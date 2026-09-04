import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// Regression coverage for the flow_pending (user-domain) half of the same fix that closed the
// 2026-09-03 duplicate-tweet incident on the content domain (see scheduled-content.test.ts's
// "does not double-post when two scheduled() sweeps race on the same xVideoStatusPoll row"). The
// retry_action branch of the flow_pending sweep had the identical gap: it only UPDATEd/DELETEd
// the pending row *after* calling executeActions, with no atomic claim beforehand, so two
// scheduled() invocations racing on the same row could both fire the retried action.
const graphWithBranches = JSON.stringify({
  nodes: [
    { id: "t1", type: "xTrigger", data: { eventType: "follow.follow", channelId: "src-chan", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "xAction", xEvent: "create-dm", channelId: "src-chan", messageText: "hi" }, position: { x: 200, y: 0 } },
    { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
    { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
    { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
  ],
});

async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, user_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
     )`
  ).run();
  // scheduled() sweeps content_flow_pending before flow_pending; it must exist even here.
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
       key TEXT PRIMARY KEY, remaining INTEGER NOT NULL, reset_at TEXT NOT NULL
     )`
  ).run();
}

async function seedFlow(flowId: string) {
  await setupSchema();
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES (?, 1, 'retry-claim flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(flowId, graphWithBranches).run();
}

describe("scheduled(): flow_pending retry_action handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id LIKE 'flow-retryclaim-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id LIKE 'flow-retryclaim-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM rate_limits`).run();
    vi.unstubAllGlobals();
  });

  it("reschedules a still-rate-limited retry_action row under a fresh id", async () => {
    await seedFlow("flow-retryclaim-1");

    const action = { type: "xAction", nodeId: "a1", hasBranches: true, xEvent: "create-dm", channelId: "src-chan", messageText: "hi" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retryclaim-1', 'flow-retryclaim-1', '', 'user-retryclaim-1', 1, '{}', ?, datetime('now'), ?, 0)`
    ).bind(past, JSON.stringify(action)).run();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 200 }))
    );

    await worker.scheduled({} as any, env);

    // The claimed row (id 'pend-retryclaim-1') is deleted and re-inserted under a fresh id — see
    // rescheduleFlowPending — so look it up by the stable user_id, not the original row id.
    const row = await env.FLOW_DB.prepare(`SELECT retry_count, execute_at FROM flow_pending WHERE user_id = 'user-retryclaim-1'`).first<{ retry_count: number; execute_at: string }>();
    expect(row?.retry_count).toBe(1);
    expect(row?.execute_at).toBe("2099-01-01T00:00:00.000Z");
  });

  // Regression test mirroring scheduled-content.test.ts's xVideoStatusPoll race test: two
  // scheduled() invocations racing on the same retry_action row must only fire the retried
  // action once, not twice.
  it("does not double-fire a retry_action row when two scheduled() sweeps race on it", async () => {
    await seedFlow("flow-retryclaim-2");

    const action = { type: "xAction", nodeId: "a1", hasBranches: true, xEvent: "create-dm", channelId: "src-chan", messageText: "hi" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retryclaim-race', 'flow-retryclaim-2', '', 'user-retryclaim-race', 1, '{}', ?, datetime('now'), ?, 0)`
    ).bind(past, JSON.stringify(action)).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await Promise.all([
      worker.scheduled({} as any, testEnv as any),
      worker.scheduled({} as any, testEnv as any),
    ]);

    const actionCalls = fetchMock.mock.calls.filter(([u]: [string]) => String(u).includes("/internal/x/action"));
    expect(actionCalls).toHaveLength(1);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM flow_pending WHERE user_id = 'user-retryclaim-race'`).all();
    expect(remaining.results).toHaveLength(0);

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);
    expect(records[0].outcome).toBe("success");
  });
});
