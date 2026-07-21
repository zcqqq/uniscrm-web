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

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-1'`).first();
    expect(remaining).toBeNull();

    // w1 is a "wait" node -- its own exit is not eagerly logged at dispatch time, so resuming it
    // emits its real exit (not relabeled to "outcome"), followed by a1's genuine enter+exit.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["w1:exit", "a1:enter", "a1:exit"]);
  });

  // videoAction nodes are stored as generic `action` nodes with data.actionType ===
  // "videoAction" (flow/nodeTypeRegistry.ts: videoAction's reactFlowType is "action") — they
  // only ever have "success"/"failed" branches, never "no". Before this fix, a timed-out
  // videoAction pending row (awaiting_event="video_action_complete", past its execute_at because
  // content's queue consumer never called back into /internal/video-action/resume) hit the
  // sweep's hardcoded `row.awaiting_event ? "no" : undefined`, which resolved a nonexistent "no"
  // edge and silently did nothing — the flow would hang forever instead of failing over.
  const graphWithVideoActionBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "videoAction", targetLanguage: "zh" }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });

  it("a timed-out videoAction pending row resumes the 'failed' branch, not 'no'", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-c2', 1, 'video action timeout flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoActionBranches).run();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
       VALUES ('pend-vaction-timeout-1', 'flow-c2', 'a1', 'content-vaction-1', 1, '{}', ?, datetime('now'), 'video_action_complete')`
    ).bind(past).run();

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vaction-timeout-1'`).first();
    expect(remaining).toBeNull();

    // The "failed" branch (a3) must have been reached — not a silent no-op, which is what
    // resolving the old hardcoded "no" branch (a nonexistent edge on this node) would produce.
    // This generic sweep path emits result.nodeLogs in full (no slicing) — a1's index-0 entry
    // is now correctly relabeled direction:"outcome" (Task 2's engine.ts fix) instead of the
    // previous "a1:exit" duplicate, so the exit badge for a1 is no longer double-counted here.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
    expect(records[0].outcome).toBe("failed");
  });
});

describe("scheduled(): content_flow_pending retry_action handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-retry1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-retry1'`).run();
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

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-retry-2'`).first();
    expect(remaining).toBeNull();

    // The retried xContentAction resolves the "success" branch (graphWithBranches's a1 -> a2).
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);
    expect(records[0].outcome).toBe("success");
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

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-retry-3'`).first();
    expect(remaining).toBeNull();

    // Retries exhausted (retry_count >= 5): resolves the "failed" branch (a3), per
    // flow/CLAUDE.md's "Rate limit重试耗尽后才走failed分支" rule.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
    expect(records[0].outcome).toBe("failed");
  });
});

describe("scheduled(): content_flow_pending xVideoStatusPoll handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-vpoll1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-vpoll1'`).run();
    vi.unstubAllGlobals();
  });

  const graphWithBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });

  it("resolves the success branch and calls x-video-status once, when it reports ok:true", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-1", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-1', 'flow-vpoll1', 'a1', 'content-vpoll-1', 1, ?, ?, datetime('now'), ?, 0)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "tweet-poll-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const statusCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/content/x-video-status"));
    expect(statusCall).toBeDefined();
    const body = JSON.parse((statusCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ channelId: "src-chan", mediaId: "media-1", text: "caption" });

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-1'`).first();
    expect(remaining).toBeNull();

    // x-video-status reports ok:true (not pending) -- resolves the "success" branch (a1 -> a2).
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);
    expect(records[0].outcome).toBe("success");
  });

  it("resolves the failed branch when x-video-status reports ok:false", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-2", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-2', 'flow-vpoll1', 'a1', 'content-vpoll-2', 1, ?, ?, datetime('now'), ?, 0)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 200 })));

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-2'`).first();
    expect(remaining).toBeNull();

    // x-video-status reports ok:false (not pending) -- resolves the "failed" branch (a1 -> a3).
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
    expect(records[0].outcome).toBe("failed");
  });

  it("reschedules (retry_count+1) when still pending and under the 5-attempt ceiling", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-3", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-3', 'flow-vpoll1', 'a1', 'content-vpoll-3', 1, ?, ?, datetime('now'), ?, 1)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: true, checkAfterSecs: 10 }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const row = await env.FLOW_DB.prepare(`SELECT retry_count, execute_at FROM content_flow_pending WHERE id = 'pend-vpoll-3'`).first<{ retry_count: number; execute_at: string }>();
    expect(row?.retry_count).toBe(2);
    expect(new Date(row!.execute_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("resolves the failed branch once pending retries are exhausted (retry_count >= 5)", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-4", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-4', 'flow-vpoll1', 'a1', 'content-vpoll-4', 1, ?, ?, datetime('now'), ?, 5)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: true, checkAfterSecs: 10 }), { status: 200 })));

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-4'`).first();
    expect(remaining).toBeNull();

    // Still pending but retries exhausted (retry_count >= 5) -- resolves the "failed" branch
    // (a1 -> a3), same rule as the retry_action describe block above.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
    expect(records[0].outcome).toBe("failed");
  });
});
