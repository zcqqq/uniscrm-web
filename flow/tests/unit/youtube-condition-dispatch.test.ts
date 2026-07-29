import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// executeContentActions's youtubeCondition branch, driven through worker.queue() the same way
// content-action-branch-node-logs.test.ts drives the xContentAction branch: a real miniflare
// FLOW_DB, a stubbed global fetch standing in for the `link` worker, and a fake
// PIPELINE_CONTENT_FLOW_LOG whose .send() calls are the observable node-log stream.
//
// youtubeCondition keeps its own node.type (like videoCondition, unlike the action nodes that are
// stored as generic "action" + data.actionType), and its branches are "true"/"false"/"failed".
// Unlike videoCondition it resolves SYNCHRONOUSLY inside executeContentActions — one videos.list
// read call, no queue hop, no content_flow_pending row of its own — so a single worker.queue()
// call is enough to observe the resolved branch.

const TRIGGER = { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } };

// yc1's three branches each land on their own leaf, so the resolved branch is readable straight
// off the emitted node logs.
function graphWithConditions(conditions: unknown) {
  return JSON.stringify({
    nodes: [
      TRIGGER,
      { id: "yc1", type: "youtubeCondition", data: { conditions }, position: { x: 200, y: 0 } },
      { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
      { id: "aFailed", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "yc1" },
      { id: "e2", source: "yc1", target: "aTrue", sourceHandle: "true" },
      { id: "e3", source: "yc1", target: "aFalse", sourceHandle: "false" },
      { id: "e4", source: "yc1", target: "aFailed", sourceHandle: "failed" },
    ],
  });
}

// Dedicated graph for the payload-freshness assertion: the "true" branch leads straight into a
// wait node, so the content_flow_pending row this branch inserts is the one observable place the
// payload carried downstream surfaces. A noopLeaf (as above) would pass whether or not the fresh
// stats were merged in, since it never persists or re-reads the payload — and carrying the fresh
// numbers downstream is the entire reason this node exists.
const graphWithWaitAfterTrue = JSON.stringify({
  nodes: [
    TRIGGER,
    { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "view_count", operator: ">", value: "1000" }] }, position: { x: 200, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "minutes" }, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "yc1" },
    { id: "e2", source: "yc1", target: "w1", sourceHandle: "true" },
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
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     )`
  ).run();
}

const FLOW_ID = "flow-yt-cond";

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

// The stale snapshot the trigger fired with. The whole point of the node is that the branch is
// decided on the values link returns NOW, not on these.
const STALE_PAYLOAD = { source_content_id: "yt-vid-1", view_count: "5", like_count: "0" };

/**
 * Publishes `graph`, stubs global fetch with `linkResponder`, runs one content.created message
 * through worker.queue(), and returns the node logs emitted by the youtubeCondition dispatch.
 *
 * pipelineSend is called twice: once for the initial executeFlow() traversal (t1/yc1 enter+exit),
 * then once more from the youtubeCondition branch with yc1's relabeled "outcome" row followed by
 * the resolved downstream node's genuine enter+exit. The second call is what's under test.
 */
async function runCondition(
  graph: string,
  linkResponder: () => Promise<Response> | Response,
  contentId: string,
  payload: Record<string, unknown> = STALE_PAYLOAD
) {
  await setupSchema();
  await env.FLOW_DB.prepare(
    `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES (?, 1, 'youtube condition flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(FLOW_ID, graph).run();

  const fetchMock = vi.fn(async (input: any) => {
    // Guard against a silent mis-wire: if the branch ever stopped calling link, a blanket stub
    // would still hand back a happy response and the test would pass for the wrong reason.
    expect(String(input)).toBe(`${(env as any).LINK_URL}/internal/youtube/video-stats`);
    return await linkResponder();
  });
  vi.stubGlobal("fetch", fetchMock);

  const pipelineSend = vi.fn().mockResolvedValue(undefined);
  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId, channelId: "src-chan", payload }),
    { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } } as any
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [records] = pipelineSend.mock.calls[1];
  return {
    fetchMock,
    outcome: records[0].outcome as string,
    failureReason: records[0].failure_reason as string | undefined,
    reached: records.slice(1).map((r: any) => r.node_id) as string[],
  };
}

describe("executeContentActions: youtubeCondition dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(FLOW_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = ?`).bind(FLOW_ID).run();
    vi.unstubAllGlobals();
  });

  it("sends the trigger video's id to link and takes the true branch when the fresh stats pass", async () => {
    const { fetchMock, outcome, reached } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "1000" }]),
      () => new Response(JSON.stringify({ ok: true, props: { view_count: "12000" } }), { status: 200 }),
      "content-yt-1"
    );
    expect(outcome).toBe("true");
    expect(reached).toEqual(["aTrue", "aTrue"]); // enter + exit
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ videoId: "yt-vid-1", contentId: "content-yt-1", flowId: FLOW_ID });
  });

  it("takes the false branch when the fresh stats miss the threshold", async () => {
    const { outcome, reached } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "99999" }]),
      () => new Response(JSON.stringify({ ok: true, props: { view_count: "12000" } }), { status: 200 }),
      "content-yt-2"
    );
    expect(outcome).toBe("false");
    expect(reached).toEqual(["aFalse", "aFalse"]);
  });

  it("takes the failed branch, carrying link's reason, when the video is gone or private", async () => {
    // link reports a business failure as HTTP 200 + { ok: false, reason } — a missing/private
    // video is not an HTTP error. "video gone" must never be collapsed into false ("didn't hit
    // the threshold"): they mean opposite things to the user.
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "1000" }]),
      () => new Response(JSON.stringify({ ok: false, reason: "video_unavailable: video not found or private" }), { status: 200 }),
      "content-yt-3"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toBe("video_unavailable: video not found or private");
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when the fetch itself throws", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "1000" }]),
      () => { throw new Error("network down"); },
      "content-yt-4"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^youtube_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when link returns a 5xx", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "1000" }]),
      () => new Response("upstream exploded", { status: 500 }),
      "content-yt-5"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^youtube_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("carries the FRESH stats — not the trigger-time snapshot — into the downstream wait node", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES (?, 1, 'youtube condition wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, graphWithWaitAfterTrue).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, props: { view_count: "12000", like_count: "340" } }), { status: 200 })
    ));

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-yt-6", channelId: "src-chan",
        payload: { ...STALE_PAYLOAD, existing_field: "keep-me" },
      }),
      { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: vi.fn().mockResolvedValue(undefined) } } as any
    );

    const scheduled = await env.FLOW_DB.prepare(
      `SELECT payload FROM content_flow_pending WHERE flow_id = ? AND node_id = 'w1'`
    ).bind(FLOW_ID).first<{ payload: string }>();
    expect(scheduled).toBeTruthy();

    const stored = JSON.parse(scheduled!.payload);
    expect(stored).toMatchObject({
      view_count: "12000",   // fresh, overwriting the trigger's "5"
      like_count: "340",     // fresh, overwriting the trigger's "0"
      source_content_id: "yt-vid-1",
      existing_field: "keep-me",
      channel_id: "src-chan",
    });
    expect(stored.view_count).not.toBe("5");
  });

  it("degrades to no-conditions instead of throwing when data.conditions is not an array", async () => {
    // A malformed graph must not throw out of executeContentActions: in the queue path a throw
    // retries the whole message, re-running every action already executed in that batch.
    const { outcome, reached } = await runCondition(
      graphWithConditions({ field: "view_count", operator: ">", value: "1000" }), // object, not array
      () => new Response(JSON.stringify({ ok: true, props: { view_count: "12000" } }), { status: 200 }),
      "content-yt-7"
    );
    expect(outcome).toBe("true"); // vacuously true: zero conditions to fail
    expect(reached).toEqual(["aTrue", "aTrue"]);
  });
});
