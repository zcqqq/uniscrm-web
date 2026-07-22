import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { resumeFromNode, type FlowGraph } from "../../src/engine";
import worker from "../../src/index";

// A YouTube content trigger feeding an X Action — the exact shape that always failed before the
// X Action gained a channel picker, because the node inherited the trigger's YouTube channel.
const youtubeToXGraph = {
  nodes: [
    { id: "t1", type: "youtubeContentTrigger", data: { channelId: "yt-chan", subscriptionChannelId: "UC1", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "x1", type: "action", data: { actionType: "xContentAction", operation: "create-post", prompt: "hi", provider: "none", channelId: "x-chan" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "x1" }],
};

describe("resumeFromNode: failureReason rides the outcome row", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 0, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "a1", target: "a2", sourceHandle: "failed" }],
  } as any;

  it("stamps the reason onto the failed outcome row only", () => {
    const result = resumeFromNode(graph, "a1", {}, "failed", "unsupported_channel_type: expected X, got YOUTUBE_ACCOUNT");

    expect(result.nodeLogs[0]).toEqual({
      nodeId: "a1",
      direction: "outcome",
      outcome: "failed",
      failureReason: "unsupported_channel_type: expected X, got YOUTUBE_ACCOUNT",
    });
    // Downstream enter/exit rows carry no reason — the failure belongs to a1, not to them.
    for (const log of result.nodeLogs.slice(1)) {
      expect(log.failureReason).toBeUndefined();
    }
  });

  it("drops the reason on a success branch, so a stale reason can never be attached", () => {
    const result = resumeFromNode(graph, "a1", {}, "success", "unsupported_channel_type: whatever");
    expect(result.nodeLogs[0]).toEqual({ nodeId: "a1", direction: "outcome", outcome: "success", failureReason: undefined });
  });

  it("leaves the reason undefined when the caller has none", () => {
    const result = resumeFromNode(graph, "a1", {}, "failed");
    expect(result.nodeLogs[0].failureReason).toBeUndefined();
  });
});

describe("xContentAction: the node's own channel, not the triggering channel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

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
      `CREATE TABLE IF NOT EXISTS content_flow_pending (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
         awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
         retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-xchan', 1, 'yt to x', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(JSON.stringify(youtubeToXGraph)).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-xchan'`).run();
    vi.unstubAllGlobals();
  });

  it("posts to the node's configured X channel and records link's reason on failure", async () => {
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: "x_api_error: create post rejected" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    await worker.queue(
      {
        queue: "uniscrm-event-dev",
        messages: [{
          // subscriptionChannelId is required for a youtubeContentTrigger to match (engine.ts:182).
          body: { tenantId: "1", eventType: "content.created", contentId: "c-1", channelId: "yt-chan", subscriptionChannelId: "UC1", payload: { title: "a video" } },
          ack: vi.fn(), retry: vi.fn(),
        }],
      } as any,
      testEnv as any
    );

    const createPostCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/internal/content/create-post"));
    expect(createPostCall).toBeDefined();
    // The whole bug: this must be the node's X channel, never the trigger's YouTube channel.
    expect(JSON.parse(createPostCall![1].body as string).channelId).toBe("x-chan");

    const outcomeRow = pipelineSend.mock.calls
      .flatMap(([records]) => records as Record<string, unknown>[])
      .find((r) => r.node_id === "x1" && r.direction === "outcome");
    expect(outcomeRow).toMatchObject({
      outcome: "failed",
      failure_reason: "x_api_error: create post rejected",
    });
  });
});
