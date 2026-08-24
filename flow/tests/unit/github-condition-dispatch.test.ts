import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TRIGGER = { id: "t1", type: "githubContentTrigger", data: { channelId: "gh-chan", repos: [{ fullName: "o/r" }], conditions: [] }, position: { x: 0, y: 0 } };

function graphWithConditions(conditions: unknown, maxWaitDays: unknown = 7) {
  return JSON.stringify({
    nodes: [
      TRIGGER,
      { id: "gc1", type: "githubCondition", data: { conditions, maxWaitDays }, position: { x: 200, y: 0 } },
      { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
      { id: "aFailed", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "gc1" },
      { id: "e2", source: "gc1", target: "aTrue", sourceHandle: "true" },
      { id: "e3", source: "gc1", target: "aFalse", sourceHandle: "false" },
      { id: "e4", source: "gc1", target: "aFailed", sourceHandle: "failed" },
    ],
  });
}

const graphWithWaitAfterTrue = JSON.stringify({
  nodes: [
    TRIGGER,
    { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }], maxWaitDays: 7 }, position: { x: 200, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "minutes" }, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "gc1" },
    { id: "e2", source: "gc1", target: "w1", sourceHandle: "true" },
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
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
     )`
  ).run();
}

const FLOW_ID = "flow-gh-cond";

function makeBatch(body: Record<string, unknown>) {
  return { queue: "uniscrm-event-dev", messages: [{ body, ack: vi.fn(), retry: vi.fn() }] } as any;
}

const STALE_PAYLOAD = { channel_id: "gh-chan", repo_full_name: "o/r", source_content_id: "9", source_created_at: "2026-08-23T00:00:00Z" };

async function runCondition(
  graph: string,
  linkResponder: () => Promise<Response> | Response,
  contentId: string,
  payload: Record<string, unknown> = STALE_PAYLOAD
) {
  await setupSchema();
  await env.FLOW_DB.prepare(
    `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES (?, 1, 'github condition flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(FLOW_ID, graph).run();

  const fetchMock = vi.fn(async (input: any) => {
    expect(String(input)).toBe(`${(env as any).LINK_URL}/internal/github/release-recheck`);
    return await linkResponder();
  });
  vi.stubGlobal("fetch", fetchMock);

  const pipelineSend = vi.fn().mockResolvedValue(undefined);
  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId, channelId: "gh-chan", repoFullName: "o/r", payload }),
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

describe("executeContentActions: githubCondition dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(FLOW_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = ?`).bind(FLOW_ID).run();
    vi.unstubAllGlobals();
  });

  it("sends the release's identity to link and takes the true branch when is_latest_release passes", async () => {
    const { fetchMock, outcome, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1, release_count_window: 3 } }), { status: 200 }),
      "content-gh-1"
    );
    expect(outcome).toBe("true");
    expect(reached).toEqual(["aTrue", "aTrue"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      channelId: "gh-chan", repoFullName: "o/r", sourceContentId: "9", publishedAt: "2026-08-23T00:00:00Z",
      maxWaitDays: 7, contentId: "content-gh-1", flowId: FLOW_ID,
    });
  });

  it("takes the false branch when is_latest_release is 0", async () => {
    const { outcome, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 0, release_count_window: 3 } }), { status: 200 }),
      "content-gh-2"
    );
    expect(outcome).toBe("false");
    expect(reached).toEqual(["aFalse", "aFalse"]);
  });

  it("takes the failed branch, carrying link's reason, when GitHub is rate-limited", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 200 }),
      "content-gh-3"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toBe("rate_limited");
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when the fetch itself throws", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => { throw new Error("network down"); },
      "content-gh-4"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^github_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when link returns a 5xx", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response("upstream exploded", { status: 500 }),
      "content-gh-5"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^github_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("carries the FRESH window props into the downstream wait node", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES (?, 1, 'github condition wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, graphWithWaitAfterTrue).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1, release_count_window: 2, release_notes_window: "[]" } }), { status: 200 })
    ));

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-gh-6", channelId: "gh-chan", repoFullName: "o/r",
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
      is_latest_release: 1, release_count_window: 2, release_notes_window: "[]",
      source_content_id: "9", existing_field: "keep-me", channel_id: "gh-chan",
    });
  });

  it("degrades to no-conditions instead of throwing when data.conditions is not an array", async () => {
    const { outcome, reached } = await runCondition(
      graphWithConditions({ field: "is_latest_release", operator: "==", value: "1" }), // object, not array
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-7"
    );
    expect(outcome).toBe("true");
    expect(reached).toEqual(["aTrue", "aTrue"]);
  });

  it("falls back to maxWaitDays: 1 when the node's config is missing/invalid", async () => {
    const { fetchMock } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }], "not-a-number"),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-8"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).maxWaitDays).toBe(1);
  });

  it("includePrerelease follows the graph's githubContentTrigger node, not a field on githubCondition itself", async () => {
    const graph = JSON.stringify({
      nodes: [
        { ...TRIGGER, data: { ...TRIGGER.data, includePrerelease: true } },
        { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }], maxWaitDays: 7 }, position: { x: 200, y: 0 } },
        { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
        { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
        { id: "aFailed", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "gc1" },
        { id: "e2", source: "gc1", target: "aTrue", sourceHandle: "true" },
        { id: "e3", source: "gc1", target: "aFalse", sourceHandle: "false" },
        { id: "e4", source: "gc1", target: "aFailed", sourceHandle: "failed" },
      ],
    });
    const { fetchMock } = await runCondition(
      graph,
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-9"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).includePrerelease).toBe(true);
  });
});
