import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const graphWithXContentTrigger = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "chan-1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

describe("emitContentNodeLogs: content-domain execution now writes node logs", () => {
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
      `CREATE TABLE IF NOT EXISTS content_flow_executions (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, event_id TEXT, content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
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
    // updateContentStatus (in the test graph below) queries env.WEB_DB.tenants — mirrors the
    // same CREATE TABLE IF NOT EXISTS pattern queue-content.test.ts's beforeEach already uses,
    // per this task's brief prose ("copy its flows/content_flow_executions/content_flow_pending/
    // tenants table setup"). No row is inserted: an absent tenants row makes tenantRow?.d1_database_id
    // falsy, so the action skips constructing a real TenantDataDB (which would otherwise fire an
    // actual Cloudflare D1 REST API call with an undefined CF_D1_API_TOKEN in this test environment).
    await env.WEB_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
         tenant_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
         d1_database_id TEXT, created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-celog1', 1, 'content flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithXContentTrigger).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-celog1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-celog1'`).run();
  });

  it("calls PIPELINE_CONTENT_FLOW_LOG.send with content_id-keyed records", async () => {
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-celog-1", channelId: "chan-1", payload: {} }),
      testEnv as any
    );

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 1, flow_id: "flow-celog1", node_id: "t1", content_id: "content-celog-1", direction: "enter" }),
    ]));
  });
});
