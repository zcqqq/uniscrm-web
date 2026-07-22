import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// videoAction nodes are stored as generic `action` nodes with data.actionType === "videoAction"
// (see flow/nodeTypeRegistry.ts's videoAction entry: reactFlowType: "action") — NOT as a
// dedicated node.type "videoAction". This mirrors flow/tests/unit/engine.test.ts's existing
// videoAction fixtures (`{ id: "a1", type: "action", data: { actionType: "videoAction", ... } }`).
const graphWithBranches = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
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

// Dedicated graph for the props-merge assertion: a1's success branch leads straight into a
// "wait" node, so the resume route's re-inserted content_flow_pending row's `payload` column is
// the one observable place the merged payload ({...JSON.parse(row.payload), ...props}) surfaces
// — a noopLeaf downstream (as in graphWithBranches above) would pass the test whether or not
// props were actually merged, since it never persists or re-reads the payload.
const graphWithWaitAfterSuccess = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "videoAction", targetLanguage: "zh" }, position: { x: 200, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "minutes" }, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "w1", sourceHandle: "success" },
  ],
});

// videoCondition keeps its own node.type (unlike videoAction, which is stored as a generic
// "action"), and its branches are "true"/"false"/"failed" — content reports only the measured
// ratio, so this graph is what the resume route consults to turn 0.35 into a branch.
const graphWithVideoCondition = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "videoCondition", data: { operation: "check-face", operator: "<=", threshold: 0.2 }, position: { x: 200, y: 0 } },
    { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
    { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    { id: "a4", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "a2", sourceHandle: "true" },
    { id: "e3", source: "a1", target: "a3", sourceHandle: "false" },
    { id: "e4", source: "a1", target: "a4", sourceHandle: "failed" },
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

function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://flow.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /internal/video-action/resume", () => {
  it("rejects without the correct X-Internal-Secret", async () => {
    const res = await worker.fetch(
      req("/internal/video-action/resume", { pendingId: "p1", branch: "success", props: {} }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("deletes the pending row and resumes the success branch, executing the downstream action", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-resume-1', 1, 'video action flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
       VALUES ('pend-resume-1', 'flow-resume-1', 'a1', 'content-resume-1', 1, ?, ?, datetime('now'), 'video_action_complete')`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past).run();

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    const res = await worker.fetch(
      req(
        "/internal/video-action/resume",
        {
          pendingId: "pend-resume-1",
          branch: "success",
          props: { processed_video_url: "https://content.test/final.mp4", video_transcript: "hi", translated_subtitle_text: "你好" },
        },
        { "X-Internal-Secret": (env as any).INTERNAL_SECRET }
      ),
      testEnv as any
    );
    expect(res.status).toBe(200);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-resume-1'`).first();
    expect(remaining).toBeNull();

    // resumeFromNode resolves a1's "success" branch down to a2 — its enter+exit must be emitted.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-resume-1'`).run();
  });

  it("merges props into the payload carried forward to a re-scheduled downstream wait node", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-resume-2', 1, 'video action wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithWaitAfterSuccess).run();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
       VALUES ('pend-resume-2', 'flow-resume-2', 'a1', 'content-resume-2', 1, ?, ?, datetime('now'), 'video_action_complete')`
    ).bind(JSON.stringify({ channel_id: "src-chan", existing_field: "keep-me" }), past).run();

    const res = await worker.fetch(
      req(
        "/internal/video-action/resume",
        {
          pendingId: "pend-resume-2",
          branch: "success",
          props: { processed_video_url: "https://content.test/final.mp4", video_transcript: "hi", translated_subtitle_text: "你好" },
        },
        { "X-Internal-Secret": (env as any).INTERNAL_SECRET }
      ),
      env
    );
    expect(res.status).toBe(200);

    // The original row was deleted; a new one was scheduled for w1 carrying the merged payload.
    const scheduled = await env.FLOW_DB.prepare(
      `SELECT payload FROM content_flow_pending WHERE flow_id = 'flow-resume-2' AND node_id = 'w1'`
    ).first<{ payload: string }>();
    expect(scheduled).toBeTruthy();
    const payload = JSON.parse(scheduled!.payload);
    expect(payload).toMatchObject({
      channel_id: "src-chan",
      existing_field: "keep-me",
      processed_video_url: "https://content.test/final.mp4",
      video_transcript: "hi",
      translated_subtitle_text: "你好",
    });

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-resume-2'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-resume-2'`).run();
  });

  it("is a no-op (200, does nothing) if the pending row was already claimed/deleted", async () => {
    await setupSchema();
    const res = await worker.fetch(
      req(
        "/internal/video-action/resume",
        { pendingId: "does-not-exist", branch: "failed", props: {} },
        { "X-Internal-Secret": (env as any).INTERNAL_SECRET }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, alreadyResolved: true });
  });

  async function resumeVideoCondition(pendingId: string, contentId: string, body: Record<string, unknown>) {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vc', 1, 'video condition flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition).run();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
       VALUES (?, 'flow-vc', 'a1', ?, 1, ?, ?, datetime('now'), 'video_action_complete')`
    ).bind(pendingId, contentId, JSON.stringify({ channel_id: "src-chan" }), past).run();

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const res = await worker.fetch(
      req("/internal/video-action/resume", { pendingId, ...body }, { "X-Internal-Secret": (env as any).INTERNAL_SECRET }),
      { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } } as any
    );
    expect(res.status).toBe(200);
    const [records] = pipelineSend.mock.calls[0];
    return { outcome: records[0].outcome, reached: records.slice(1).map((r: any) => r.node_id) };
  }

  it("videoCondition: a ratio at or under the threshold resolves the true branch", async () => {
    const { outcome, reached } = await resumeVideoCondition("pend-vc-1", "content-vc-1", {
      branch: "success", props: { face_ratio: 0.15 },
    });
    expect(outcome).toBe("true");
    expect(reached).toContain("a2");
  });

  it("videoCondition: a ratio above the threshold resolves the false branch", async () => {
    const { outcome, reached } = await resumeVideoCondition("pend-vc-2", "content-vc-2", {
      branch: "success", props: { face_ratio: 0.35 },
    });
    expect(outcome).toBe("false");
    expect(reached).toContain("a3");
  });

  it("videoCondition: a measured ratio of 0 is a real answer, not a failure", async () => {
    const { outcome, reached } = await resumeVideoCondition("pend-vc-3", "content-vc-3", {
      branch: "success", props: { face_ratio: 0 },
    });
    expect(outcome).toBe("true");
    expect(reached).toContain("a2");
  });

  it("videoCondition: content reporting failed resolves the failed branch, never true/false", async () => {
    const { outcome, reached } = await resumeVideoCondition("pend-vc-4", "content-vc-4", {
      branch: "failed", props: {},
    });
    expect(outcome).toBe("failed");
    expect(reached).toContain("a4");
  });

  it("videoCondition: a success callback with no measurable ratio resolves failed, not a guess", async () => {
    const { outcome, reached } = await resumeVideoCondition("pend-vc-5", "content-vc-5", {
      branch: "success", props: {},
    });
    expect(outcome).toBe("failed");
    expect(reached).toContain("a4");
  });
});
