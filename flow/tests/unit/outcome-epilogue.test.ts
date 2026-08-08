import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// Batch E: recordBranchOutcome 是 user/content 两域分支解析收尾的唯一实现。这里钉住三件事：
// (a) content 域的 pending wait 行从此带 conditions + condition_logic 快照（此前 condition_logic
//     从不落库，部分调用点连 conditions 都不写）；
// (b) content sweep 到期解析 waitForEvent 行时用 conditionsPass 对存储 payload 的 props 求值，
//     通过走 "yes"、不通过走 "no"——条件不再是写了没人读的死数据；
// (c) 同一份 waitForEvent 节点数据经 user 域（executeActions/webhook）与 content 域
//     （executeContentActions/xContentAction）落下的 pending 快照逐字相同。

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

// vitest-pool-workers 不会自动应用 migrations/（见 queue-content.test.ts 的注释）——手建
// post-migration schema，含 0014/0015 的 flows.domain / trigger_count 与 0016/0017 的
// condition_logic。
beforeAll(async () => {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       domain TEXT NOT NULL DEFAULT 'user', trigger_count INTEGER
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
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
     )`
  ).run();
});

const WAIT_CONDITIONS = [{ field: "like_count", operator: ">", value: "10" }];

// 同一份 waitForEvent 节点数据，(a)/(c) 两组用例共享，保证两域比较的是同源快照。
const WAIT_NODE_DATA = {
  eventType: "content.created",
  duration: 1,
  unit: "days",
  conditions: WAIT_CONDITIONS,
  conditionLogic: "or",
};

const contentGraph = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "xContentAction", prompt: "Rewrite", provider: "default" }, position: { x: 200, y: 0 } },
    { id: "w1", type: "waitForEvent", data: WAIT_NODE_DATA, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "w1", sourceHandle: "success" },
  ],
});

describe("recordBranchOutcome: content pending waits snapshot conditions + condition_logic", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-epi-snap'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-epi-snap'`).run();
    vi.unstubAllGlobals();
  });

  it("a waitForEvent reached through a resolved branch stores the node's conditions and conditionLogic", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, domain, created_at, updated_at)
       VALUES ('flow-epi-snap', 1, 'epilogue snapshot flow', ?, 'published', 'content', datetime('now'), datetime('now'))`
    ).bind(contentGraph).run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-epi-1", channelId: "src-chan", payload: {} }),
      env
    );

    const row = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, conditions, condition_logic, payload FROM content_flow_pending WHERE flow_id = 'flow-epi-snap'`
    ).first<{ node_id: string; awaiting_event: string; conditions: string; condition_logic: string; payload: string }>();
    expect(row).not.toBeNull();
    expect(row!.node_id).toBe("w1");
    expect(row!.awaiting_event).toBe("content.created");
    expect(JSON.parse(row!.conditions)).toEqual(WAIT_CONDITIONS);
    expect(row!.condition_logic).toBe("or");
    // channel_id 仍要混进存储 payload——sweep 解析后下游 action 靠它拿回 SOURCE channel。
    expect(JSON.parse(row!.payload).channel_id).toBe("src-chan");
  });
});

describe("scheduled(): content sweep evaluates the conditions snapshot on waitForEvent rows", () => {
  // yes/no 双分支，钉住条件求值真的在选边，而不是恒走某一边。
  const sweepGraph = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "w1", type: "waitForEvent", data: WAIT_NODE_DATA, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "w1" },
      { id: "e2", source: "w1", target: "a2", sourceHandle: "yes" },
      { id: "e3", source: "w1", target: "a3", sourceHandle: "no" },
    ],
  });

  async function seedSweepRow(id: string, payload: Record<string, unknown>, conditions: string, conditionLogic: string) {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, domain, created_at, updated_at)
       VALUES ('flow-epi-sweep', 1, 'epilogue sweep flow', ?, 'published', 'content', datetime('now'), datetime('now'))`
    ).bind(sweepGraph).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
       VALUES (?, 'flow-epi-sweep', 'w1', 'content-epi-sweep', 1, ?, ?, datetime('now'), 'content.created', ?, ?)`
    ).bind(id, JSON.stringify(payload), new Date(Date.now() - 1000).toISOString(), conditions, conditionLogic).run();
  }

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-epi-sweep'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-epi-sweep'`).run();
    vi.unstubAllGlobals();
  });

  it("failing conditions resolve the 'no' branch — never the 'yes' success path", async () => {
    await seedSweepRow("pend-epi-no", { like_count: 5, channel_id: "src-chan" }, JSON.stringify(WAIT_CONDITIONS), "");

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-epi-no'`).first();
    expect(remaining).toBeNull();

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["w1:exit", "a3:enter", "a3:exit"]);
  });

  it("passing conditions resolve the 'yes' branch", async () => {
    await seedSweepRow("pend-epi-yes", { like_count: 20, channel_id: "src-chan" }, JSON.stringify(WAIT_CONDITIONS), "");

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["w1:exit", "a2:enter", "a2:exit"]);
  });

  it("OR with zero usable conditions never passes (identity is false) — resolves 'no'", async () => {
    // 与 user 域 conditionsPass 的口径逐字一致：OR + 空集恒不过，不能被当成 AND 放行。
    await seedSweepRow("pend-epi-or0", { like_count: 999, channel_id: "src-chan" }, "", "or");

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.scheduled({} as any, testEnv as any);

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["w1:exit", "a3:enter", "a3:exit"]);
  });
});

describe("recordBranchOutcome: user and content domains write byte-identical wait snapshots", () => {
  // user 域用 webhook（success/failed 分支、无 rate_limits 依赖），content 域用 xContentAction，
  // 两条链的 success 分支都指向同一份 WAIT_NODE_DATA 的 waitForEvent 节点。
  const userGraph = JSON.stringify({
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "tweet.like", channelId: "chan-u", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "wh1", type: "webhook", data: { url: "https://example.com/hook", method: "POST" }, position: { x: 200, y: 0 } },
      { id: "w1", type: "waitForEvent", data: WAIT_NODE_DATA, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "wh1" },
      { id: "e2", source: "wh1", target: "w1", sourceHandle: "success" },
    ],
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id IN ('flow-epi-user', 'flow-epi-content')`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = 'flow-epi-user'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-epi-content'`).run();
    vi.unstubAllGlobals();
  });

  it("the same waitForEvent node yields the same awaiting_event/conditions/condition_logic in both tables", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, domain, created_at, updated_at)
       VALUES ('flow-epi-user', 1, 'user epilogue flow', ?, 'published', 'user', datetime('now'), datetime('now'))`
    ).bind(userGraph).run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "tweet.like", userId: "user-epi-1", channelId: "chan-u", payload: {} }),
      env
    );

    const userRow = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, conditions, condition_logic FROM flow_pending WHERE flow_id = 'flow-epi-user'`
    ).first<{ node_id: string; awaiting_event: string; conditions: string; condition_logic: string }>();
    expect(userRow).not.toBeNull();
    expect(userRow!.node_id).toBe("w1");

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-epi-user'`).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, domain, created_at, updated_at)
       VALUES ('flow-epi-content', 1, 'content epilogue flow', ?, 'published', 'content', datetime('now'), datetime('now'))`
    ).bind(contentGraph).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-epi-2", channelId: "src-chan", payload: {} }),
      env
    );

    const contentRow = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, conditions, condition_logic FROM content_flow_pending WHERE flow_id = 'flow-epi-content'`
    ).first<{ node_id: string; awaiting_event: string; conditions: string; condition_logic: string }>();
    expect(contentRow).not.toBeNull();

    // 快照三元组逐字相同——两域走的是同一个 recordBranchOutcome INSERT。
    expect(contentRow!.node_id).toBe(userRow!.node_id);
    expect(contentRow!.awaiting_event).toBe(userRow!.awaiting_event);
    expect(contentRow!.conditions).toBe(userRow!.conditions);
    expect(contentRow!.condition_logic).toBe(userRow!.condition_logic);
    expect(contentRow!.condition_logic).toBe("or");
    expect(JSON.parse(contentRow!.conditions)).toEqual(WAIT_CONDITIONS);
  });
});
