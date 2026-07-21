import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// Both scenarios below use an xContentTrigger -> xContentAction -> noopLeaf graph,
// where the xContentAction node ("a1") has a success branch (-> a2) and a failed branch (-> a3).
// resumeFromNode(graph, "a1", payload, branch) is called at two call sites in src/index.ts to
// resolve which of a2/a3 fires once the async xContentAction's outcome (ok/rateLimited) is known:
//   Site 1: executeContentActions's xContentAction branch, immediately after a non-rate-limited
//           fetch response (queue() dispatch path).
//   Site 2: scheduled()'s content_flow_pending retry-exhausted handling (a1 was rate-limited on
//           every attempt, so once retries are exhausted the "failed" branch is resolved directly).
// resumeFromNode's returned nodeLogs[0] is a1's own duplicate exit, relabeled direction:"outcome"
// (carrying the resolved branch) rather than dropped — everything from index 1 onward (a2 or a3's
// genuine enter+exit) is the new downstream traversal. Both are emitted via
// emitContentNodeLogs/PIPELINE_CONTENT_FLOW_LOG.send.
const graphWithBranches = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
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
       created_at TEXT NOT NULL
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     )`
  ).run();
}

describe("xContentAction branch resolution: downstream node logs (Site 1 — queue() dispatch)", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-nodelog-1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-nodelog-1'`).run();
    vi.unstubAllGlobals();
  });

  it("emits a2's enter+exit (not a1's duplicate exit) when the success branch resolves synchronously", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-nodelog-1', 1, 'branch flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-nodelog-1", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    // First call is the initial executeFlow() dispatch (t1 enter/exit, a1 enter/exit) — pre-existing
    // and unrelated to this fix. The fix under test is the SECOND call, made once resumeFromNode
    // resolves a1's "success" branch down to a2.
    expect(pipelineSend).toHaveBeenCalledTimes(2);

    const [firstCallRecords] = pipelineSend.mock.calls[0];
    expect(firstCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "t1:enter", "t1:exit", "a1:enter", "a1:exit",
    ]);

    const [secondCallRecords] = pipelineSend.mock.calls[1];
    // a1's relabeled outcome row, then a2's genuine enter+exit.
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a2:enter", "a2:exit",
    ]);
    expect(secondCallRecords[0].outcome).toBe("success");
    expect(secondCallRecords.every((r: any) => r.content_id === "content-nodelog-1")).toBe(true);
  });

  it("emits a3's enter+exit when the failed branch resolves synchronously", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-nodelog-1', 1, 'branch flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 502 })));

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-nodelog-2", channelId: "src-chan", payload: {} }),
      testEnv as any
    );

    expect(pipelineSend).toHaveBeenCalledTimes(2);
    const [secondCallRecords] = pipelineSend.mock.calls[1];
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(secondCallRecords[0].outcome).toBe("failed");
  });
});

describe("xContentAction branch resolution: downstream node logs (Site 2 — scheduled() retry-exhausted)", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-nodelog-2'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-nodelog-2'`).run();
    vi.unstubAllGlobals();
  });

  it("emits a3's enter+exit when rate-limit retries are exhausted and the failed branch resolves", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-nodelog-2', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "xContentAction", nodeId: "a1", hasBranches: true, prompt: "Rewrite: $content.content_text", provider: "default" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-nodelog-1', 'flow-nodelog-2', '', 'content-nodelog-3', 1, '{}', ?, datetime('now'), ?, 5)`
    ).bind(past, JSON.stringify(action)).run();

    // Still rate-limited on this final attempt — retry_count (5) is no longer < 5, so retries are
    // exhausted and the "failed" branch (a3) must be resolved.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.scheduled({} as any, testEnv as any);

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(records[0].outcome).toBe("failed");
    expect(records.every((r: any) => r.content_id === "content-nodelog-3")).toBe(true);
  });
});
