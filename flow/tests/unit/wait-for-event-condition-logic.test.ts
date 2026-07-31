import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { executeFlow, type FlowGraph } from "../../src/engine";
import { CONDITION_LOGIC_OR } from "../../nodeTypeRegistry";

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

function pipelineTestEnv() {
  // emitNodeLogs does `env.PIPELINE_FLOW_LOG?.send(...)` — stubbed per the established pattern
  // (x-action-branch-node-logs.test.ts, emit-node-logs.test.ts) so the real dev Pipeline binding
  // is never touched from a unit test.
  return { ...env, PIPELINE_FLOW_LOG: { send: vi.fn().mockResolvedValue(undefined) } };
}

function graphWithWait(waitData: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "w1", type: "waitForEvent", data: { eventType: "tweet.liked", duration: 3, unit: "days", ...waitData }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "w1" }],
  };
}

describe("waitForEvent 把 conditionLogic 一起快照进 PendingWait", () => {
  const COND = [{ field: "like_count", operator: ">", value: "5" }];

  it("节点上是 'or' 时带进 pendingWait", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits).toHaveLength(1);
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("节点上没有这个键时为空串（= AND），不是 undefined —— D1 列 NOT NULL", () => {
    const r = executeFlow(graphWithWait({ conditions: COND }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("");
  });

  it("0 条条件时依然带上 logic —— OR + 0 条是有语义的（拦住），不能丢", () => {
    const r = executeFlow(graphWithWait({ conditions: [], conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("畸形 logic 被规整成字符串，不会把非字符串塞进 D1 bind", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: { bad: 1 } }), "follow.followed", { channel_id: "chan1" });
    expect(typeof r.pendingWaits[0].conditionLogic).toBe("string");
  });
});

// Handler-level tests: drive the real code in src/index.ts (worker.queue) rather than calling
// conditionsPass directly — that function is Task 1's, already fully covered there. What's new
// and safety-critical in THIS task is (a) the try/catch around JSON.parse(pending.conditions) in
// the pendingMatches loop, (b) removing the `if (pending.conditions)` truthy guard, and (c) the
// rewritten INSERT INTO flow_pending statements actually having the right column list/placeholder
// count. None of those are reachable by calling conditionsPass in isolation.
//
// vitest-pool-workers doesn't auto-apply this module's migrations/ directory (no
// <BINDING>_MIGRATIONS binding wired up) — same empirically-verified fact documented in
// queue-content.test.ts's beforeAll. Create the post-0016 schema by hand.
describe("queue(): waitForEvent 的 condition_logic 快照在真实 handler 中生效", () => {
  beforeAll(async () => {
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
         created_at TEXT NOT NULL,
         condition_logic TEXT NOT NULL DEFAULT ''
       )`
    ).run();
  });

  describe("INSERT 快照往返 (index.ts 主匹配循环里改写的那一处 INSERT INTO flow_pending)", () => {
    // Only one of the four rewritten INSERT sites is reachable this way (see task-3-report.md
    // for why the other three — the branch-resume insert in executeActions, the rate-limit-
    // exhausted nested-branch insert, and the sweep reschedule insert — are not covered here).
    const GRAPH = JSON.stringify({
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan-insert-1", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "w1", type: "waitForEvent",
          data: {
            eventType: "tweet.liked", duration: 3, unit: "days",
            conditions: [{ field: "like_count", operator: ">", value: "5" }],
            conditionLogic: CONDITION_LOGIC_OR,
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "w1" }],
    });

    afterEach(async () => {
      await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-insert-1'`).run();
      await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = 'flow-insert-1'`).run();
    });

    it("写入的 flow_pending 行的 conditions/condition_logic 与节点上的快照一致（列清单与占位符没有错位）", async () => {
      await env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
         VALUES ('flow-insert-1', 1, 'insert test flow', ?, 'published', datetime('now'), datetime('now'))`
      ).bind(GRAPH).run();

      await worker.queue(
        makeBatch({ tenantId: "1", eventType: "follow.followed", userId: "user-insert-1", channelId: "chan-insert-1", payload: {} }),
        pipelineTestEnv() as any
      );

      const row = await env.FLOW_DB.prepare(
        `SELECT conditions, condition_logic, awaiting_event FROM flow_pending WHERE flow_id = 'flow-insert-1' AND node_id = 'w1'`
      ).first<{ conditions: string; condition_logic: string; awaiting_event: string }>();
      expect(row).toBeTruthy();
      expect(row!.awaiting_event).toBe("tweet.liked");
      expect(row!.condition_logic).toBe("or");
      expect(JSON.parse(row!.conditions)).toEqual([{ field: "like_count", operator: ">", value: "5" }]);
    });
  });

  describe("resume 时的安全性：畸形快照不放大成整条消息重试；AND/OR + 0 条不回归", () => {
    async function seedFlow(flowId: string) {
      // No outgoing edges from w1: keeps the assertion focused on the pendingMatches loop's own
      // try/catch + conditionsPass call, not on what resumeFromNode does downstream.
      const graph = JSON.stringify({
        nodes: [{ id: "w1", type: "waitForEvent", data: { eventType: "tweet.liked", duration: 3, unit: "days" }, position: { x: 0, y: 0 } }],
        edges: [],
      });
      await env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
         VALUES (?, 1, 'resume test flow', ?, 'published', datetime('now'), datetime('now'))`
      ).bind(flowId, graph).run();
    }

    async function seedPending(id: string, flowId: string, userId: string, conditions: string, conditionLogic: string) {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // still pending, not timed out
      await env.FLOW_DB.prepare(
        `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
         VALUES (?, ?, 'w1', ?, 1, '{}', ?, datetime('now'), 'tweet.liked', ?, ?)`
      ).bind(id, flowId, userId, future, conditions, conditionLogic).run();
    }

    afterEach(async () => {
      await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id LIKE 'flow-resume-%'`).run();
      await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id LIKE 'flow-resume-%' OR id LIKE 'pending-%'`).run();
    });

    it("坏 JSON 的 conditions 列不会让整条队列消息被 retry —— 降级成 0 条，AND 下放行并把行 claim 掉", async () => {
      await seedFlow("flow-resume-badjson");
      await seedPending("pending-badjson", "flow-resume-badjson", "user-badjson", "not json", "");

      const batch = makeBatch({ tenantId: "1", eventType: "tweet.liked", userId: "user-badjson", channelId: "irrelevant", payload: {} });
      await worker.queue(batch, pipelineTestEnv() as any);

      // The meaningful signal: without the try/catch, JSON.parse throws, escapes the pendingMatches
      // loop, and is caught by queue()'s outer per-message catch — which calls retry() instead of
      // ever reaching ack(). If this regresses, retry fires and ack doesn't.
      expect(batch.messages[0].retry).not.toHaveBeenCalled();
      expect(batch.messages[0].ack).toHaveBeenCalled();
      // And confirms the degrade-to-empty-conditions behavior, not just "didn't crash": AND + 0
      // conditions passes, so the row gets atomically claimed (DELETEd).
      const claimed = await env.FLOW_DB.prepare(`SELECT id FROM flow_pending WHERE id = 'pending-badjson'`).first();
      expect(claimed).toBeNull();
    });

    it("AND + 0 条件（空数组快照）仍然放行——去掉 truthy 守卫没有引入回归", async () => {
      await seedFlow("flow-resume-and0");
      await seedPending("pending-and0", "flow-resume-and0", "user-and0", "[]", "");

      await worker.queue(
        makeBatch({ tenantId: "1", eventType: "tweet.liked", userId: "user-and0", channelId: "irrelevant", payload: {} }),
        pipelineTestEnv() as any
      );

      const stillPending = await env.FLOW_DB.prepare(`SELECT id FROM flow_pending WHERE id = 'pending-and0'`).first();
      expect(stillPending).toBeNull(); // claimed: AND + 0 passed, wait resolved
    });

    it("OR + 0 条件不放行——[].some() 恒假，行必须原样留在 flow_pending 里继续等待", async () => {
      await seedFlow("flow-resume-or0");
      await seedPending("pending-or0", "flow-resume-or0", "user-or0", "[]", CONDITION_LOGIC_OR);

      await worker.queue(
        makeBatch({ tenantId: "1", eventType: "tweet.liked", userId: "user-or0", channelId: "irrelevant", payload: {} }),
        pipelineTestEnv() as any
      );

      const stillPending = await env.FLOW_DB.prepare(`SELECT id FROM flow_pending WHERE id = 'pending-or0'`).first();
      expect(stillPending).toBeTruthy(); // NOT claimed: OR + 0 blocked, wait left in place
    });
  });
});
