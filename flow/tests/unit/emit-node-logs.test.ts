import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const graphWithXTrigger = JSON.stringify({
  nodes: [
    { id: "t1", type: "xTrigger", data: { channelType: "X", eventType: "follow.followed", channelId: "", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

describe("emitNodeLogs: sends directly to PIPELINE_FLOW_LOG, no queue", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_executions (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, event_id TEXT, user_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-elog1', 1, 'x flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithXTrigger).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-elog1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_executions WHERE flow_id = 'flow-elog1'`).run();
  });

  it("calls PIPELINE_FLOW_LOG.send with the expected records and never touches FLOW_LOG_QUEUE", async () => {
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend }, FLOW_LOG_QUEUE: { send: queueSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.followed", userId: "user-elog-1", channelId: "chan-1", payload: {} }),
      testEnv as any
    );

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 1, flow_id: "flow-elog1", node_id: "t1", user_id: "user-elog-1", direction: "enter" }),
    ]));
    expect(queueSend).not.toHaveBeenCalled();
  });
});
