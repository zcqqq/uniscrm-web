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

  // Regression test for the loss this commit's atomic claim introduced: the row is claimed
  // (DELETEd) before row.retry_action is even parsed, so a JSON.parse throw used to be caught
  // only by the generic per-row catch, which just logs — the row was gone for good. Nothing
  // outbound has happened yet at this point (JSON.parse is local), so it must be safe to put the
  // row back, unlike a throw after executeActions dispatches below.
  it("reschedules a retry_action row (retry_count unchanged) when its stored JSON is malformed, without calling fetch", async () => {
    await seedFlow("flow-retryclaim-badjson");

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retryclaim-badjson', 'flow-retryclaim-badjson', '', 'user-retryclaim-badjson', 1, '{}', ?, '2026-01-01T00:00:00.000Z', '{not valid json', 2)`
    ).bind(past).run();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await worker.scheduled({} as any, env);

    // recomputeFlowCounts() (unrelated, runs at the top of every scheduled() tick) also calls
    // global fetch — filter those out; what matters here is that nothing tried to dispatch the
    // unparseable retry_action.
    const dispatchCalls = fetchMock.mock.calls.filter(([u]: [string]) => !String(u).includes("r2-sql"));
    expect(dispatchCalls).toHaveLength(0);

    // Re-inserted under a fresh id (rescheduleFlowPending) — look it up by the stable user_id.
    // retry_count and created_at both survive unchanged: this is an infra retry (bad JSON), not a
    // business rate-limit retry, so it must not consume the retry_count budget that "after N
    // retries" messages elsewhere read, nor reset how long the row has been pending.
    const row = await env.FLOW_DB.prepare(
      `SELECT retry_count, retry_action, created_at, execute_at FROM flow_pending WHERE user_id = 'user-retryclaim-badjson'`
    ).first<{ retry_count: number; retry_action: string; created_at: string; execute_at: string }>();
    expect(row?.retry_count).toBe(2);
    expect(row?.retry_action).toBe("{not valid json");
    expect(row?.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(row!.execute_at).getTime()).toBeGreaterThan(Date.now());
  });

  // Regression test proving the narrow prep-phase reschedule added alongside the atomic claim
  // (see the "malformed retry_action JSON" test above) does NOT extend past executeActions'
  // dispatch. Once the retried action has actually been attempted, the row must be dropped on any
  // later exception, not put back — putting it back would re-attempt the action next sweep,
  // recreating the double-fire class of bug the upfront claim exists to prevent.
  const graphWithRealDownstreamAction = JSON.stringify({
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "follow.follow", channelId: "src-chan", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xAction", xEvent: "create-dm", channelId: "src-chan", messageText: "hi" }, position: { x: 200, y: 0 } },
      // Unlike graphWithBranches's noopLeaf a2, this is a real dispatching action so entering the
      // "success" branch triggers a second, genuinely outbound fetch call.
      { id: "a2", type: "action", data: { actionType: "xAction", xEvent: "create-dm", channelId: "src-chan", messageText: "follow-up" }, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
    ],
  });

  it("does not re-insert the row when a later step throws after the retried action already dispatched", async () => {
    await seedFlow("flow-retryclaim-postdispatch");
    await env.FLOW_DB.prepare(`UPDATE flows SET graph_json = ? WHERE id = 'flow-retryclaim-postdispatch'`).bind(graphWithRealDownstreamAction).run();

    const action = { type: "xAction", nodeId: "a1", hasBranches: true, xEvent: "create-dm", channelId: "src-chan", messageText: "hi" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retryclaim-postdispatch', 'flow-retryclaim-postdispatch', '', 'user-retryclaim-postdispatch', 1, '{}', ?, datetime('now'), ?, 0)`
    ).bind(past, JSON.stringify(action)).run();

    // First call: the retried a1 action actually dispatches and succeeds. Second call: the
    // downstream a2 action, simulating a failure that occurs strictly after the retried action
    // has already taken effect.
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockImplementationOnce(async () => { throw new Error("simulated network failure after dispatch"); });
    vi.stubGlobal("fetch", fetchMock);

    await worker.scheduled({} as any, env);

    const actionCalls = fetchMock.mock.calls.filter(([u]: [string]) => String(u).includes("/internal/x/action"));
    expect(actionCalls).toHaveLength(1);

    // The row must be gone for good — not re-inserted for the next sweep to pick up, which would
    // re-dispatch the already-fired a1 action a second time.
    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM flow_pending WHERE user_id = 'user-retryclaim-postdispatch'`).all();
    expect(remaining.results).toHaveLength(0);

    // A second sweep (nothing left to pick up) makes no further /internal/x/action calls.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await worker.scheduled({} as any, env);
    const secondSweepActionCalls = fetchMock.mock.calls.filter(([u]: [string]) => String(u).includes("/internal/x/action"));
    expect(secondSweepActionCalls).toHaveLength(0);
  });
});
