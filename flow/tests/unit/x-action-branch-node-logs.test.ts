import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// Regression: a user-flow X Action's success/failed branches never continued. buildActionData
// marks xAction hasBranches:true, so processTargetNode stops traversing at the action node and
// waits for the branch to be resolved — but executeActions only ever recorded an outcome row for
// the analytics drawer and never called resumeFromNode. A DM node whose "failed" edge led to an
// Unfollow node showed "failed" in analytics while the Unfollow never ran.
//
// This mirrors content-action-branch-node-logs.test.ts, which covers the same shape in the
// content domain (where branch resolution already worked).
//
// a2/a3 use an actionType with no executor of its own ("noopLeaf"): hasBranches is false for it,
// so collectActions logs its enter+exit at traversal time — which is exactly the evidence that
// the branch was walked.
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

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

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
  // scheduled() sweeps this table before flow_pending; it must exist even for a user-flow test.
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
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
     VALUES (?, 1, 'branch flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(flowId, graphWithBranches).run();
}

// link's /internal/x/action response, plus a permissive fallback for any other fetch the worker
// makes (none today, but a 200 keeps an unrelated call from failing the assertion below).
function stubXAction(body: Record<string, unknown>, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe("xAction branch resolution (queue dispatch)", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id LIKE 'flow-xbranch-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id LIKE 'flow-xbranch-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM rate_limits`).run();
    vi.unstubAllGlobals();
  });

  it("walks the failed branch to a3 when link reports the X call failed", async () => {
    await seedFlow("flow-xbranch-1");
    stubXAction({ ok: false, reason: "x_api_error: HTTP 403" }, 403);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.follow", userId: "x-user-1", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    // Call 1 is executeFlow's own traversal (pre-existing). Call 2 is the fix: a1's outcome row
    // plus a3's genuine enter+exit, reached by resolving the "failed" branch.
    expect(pipelineSend).toHaveBeenCalledTimes(2);
    expect(pipelineSend.mock.calls[0][0].map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "t1:enter", "t1:exit", "a1:enter", "a1:exit",
    ]);

    const second = pipelineSend.mock.calls[1][0];
    expect(second.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(second[0].outcome).toBe("failed");
    expect(second[0].failure_reason).toBe("x_api_error: HTTP 403");
    expect(second.every((r: any) => r.user_id === "x-user-1")).toBe(true);
  });

  it("walks the success branch to a2 when link reports the X call succeeded", async () => {
    await seedFlow("flow-xbranch-2");
    stubXAction({ ok: true });

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.follow", userId: "x-user-2", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    const second = pipelineSend.mock.calls[1][0];
    expect(second.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a2:enter", "a2:exit",
    ]);
    expect(second[0].outcome).toBe("success");
  });

  it("records exactly one outcome row per action — resumeFromNode's, never a second one", async () => {
    await seedFlow("flow-xbranch-3");
    stubXAction({ ok: false, reason: "x_api_error: HTTP 500" }, 500);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.follow", userId: "x-user-3", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    // Double-counting here would inflate the analytics drawer's failure count for every action.
    const allRecords = pipelineSend.mock.calls.flatMap(([records]: any) => records);
    expect(allRecords.filter((r: any) => r.node_id === "a1" && r.direction === "outcome")).toHaveLength(1);
  });

  it("takes no branch while the action is still rate-limited (a 429 is not yet a failure)", async () => {
    await seedFlow("flow-xbranch-4");
    stubXAction({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }, 429);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.follow", userId: "x-user-4", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    // Only executeFlow's own traversal — per flow/CLAUDE.md the failed branch waits for retries
    // to be exhausted, and the action is rescheduled as a flow_pending retry row instead.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const retryRow = await env.FLOW_DB.prepare(
      `SELECT retry_action FROM flow_pending WHERE flow_id = 'flow-xbranch-4'`
    ).first<{ retry_action: string }>();
    expect(retryRow?.retry_action).toContain("a1");
  });
});

describe("xAction branch resolution (scheduled retry-exhausted)", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id LIKE 'flow-xbranch-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id LIKE 'flow-xbranch-%'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM rate_limits`).run();
    vi.unstubAllGlobals();
  });

  it("resolves the failed branch once rate-limit retries run out", async () => {
    await seedFlow("flow-xbranch-5");
    const action = { type: "xAction", nodeId: "a1", hasBranches: true, xEvent: "create-dm", channelId: "src-chan", userId: "x-user-5" };
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-xbranch-1', 'flow-xbranch-5', '', 'x-user-5', 1, '{}', ?, datetime('now'), ?, 5)`
    ).bind(new Date(Date.now() - 1000).toISOString(), JSON.stringify(action)).run();

    stubXAction({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }, 429);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend } };

    await worker.scheduled({} as any, testEnv as any);

    const records = pipelineSend.mock.calls.flatMap(([r]: any) => r);
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(records[0].outcome).toBe("failed");
    expect(records[0].failure_reason).toContain("rate_limit_exhausted");
  });
});
