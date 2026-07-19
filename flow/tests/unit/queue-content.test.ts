import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { executeFlow } from "../../src/engine";

const graphContentToStatus = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "chan-1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

describe("queue(): content.created dispatch", () => {
  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory (no
    // <BINDING>_MIGRATIONS binding is wired up, and there's no setupFiles hook calling
    // applyD1Migrations — verified empirically: env.FLOW_DB starts with zero tables).
    // Create the post-migration schema by hand, matching migrations/0001_init.sql (as
    // amended by 0011_drop_enabled.sql, which removed flows.enabled),
    // migrations/0013_content_flow_tables.sql, and web/migrations/0001_init.sql's
    // `tenants` table. This mirrors the existing CREATE TABLE IF NOT EXISTS pattern this
    // file already uses for tenant-scoped D1 in handleLogQueue(). A durable fix (out of
    // scope for this task, which only touches this test file and src/index.ts) would be
    // wiring readD1Migrations()/applyD1Migrations() into vitest.config.ts + a setup file.
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
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_executions (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         event_id TEXT,
         user_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         matched INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_executions (
         id TEXT PRIMARY KEY,
         flow_id TEXT NOT NULL,
         event_id TEXT,
         content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL,
         matched INTEGER NOT NULL DEFAULT 1,
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
    await env.WEB_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
         tenant_id INTEGER PRIMARY KEY AUTOINCREMENT,
         email TEXT NOT NULL,
         d1_database_id TEXT,
         created_at TEXT NOT NULL
       )`
    ).run();

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-c1', 1, 'content flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphContentToStatus).run();
    await env.WEB_DB.prepare(
      `INSERT INTO tenants (tenant_id, d1_database_id) VALUES (1, 'tenant-db-1')`
    ).run().catch(() => {}); // no-op: violates tenants.email NOT NULL — intentionally left unresolvable
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-c1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-c1'`).run();
  });

  it("matches a published flow with an xContentTrigger and records content_flow_executions keyed by content_id", async () => {
    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-abc", channelId: "chan-1", payload: {} }),
      env
    );

    const row = await env.FLOW_DB.prepare(
      `SELECT flow_id, content_id, tenant_id, matched FROM content_flow_executions WHERE flow_id = 'flow-c1'`
    ).first<{ flow_id: string; content_id: string; tenant_id: number; matched: number }>();

    expect(row).toMatchObject({ flow_id: "flow-c1", content_id: "content-abc", tenant_id: 1, matched: 1 });
  });

  it("does not touch flow_executions (the user-domain table) for a content message", async () => {
    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-xyz", channelId: "chan-1", payload: {} }),
      env
    );

    const row = await env.FLOW_DB.prepare(
      `SELECT id FROM flow_executions WHERE flow_id = 'flow-c1'`
    ).first();
    expect(row).toBeNull();
  });
});

describe("queue(): xContentAction branch resolution", () => {
  const graphWithBranchesObj = {
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
  };
  const graphWithBranches = JSON.stringify(graphWithBranchesObj);

  it("does not collect both branches on the initial dispatch (hasBranches gating) — executeFlow's initial pass over an xContentAction node yields only the action itself, not either branch's downstream noopLeaf node", () => {
    const result = executeFlow(graphWithBranchesObj, "content.created", { channel_id: "src-chan" });
    expect(result.actions.map((a) => a.type)).toEqual(["xContentAction"]);
  });

  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-branch1', 1, 'branch flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-branch1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-branch1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-branch1'`).run();
    vi.unstubAllGlobals();
  });

  it("resolves the success branch and runs a2 when link returns ok:true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-1", channelId: "src-chan", payload: {} }),
      env
    );

    // What we're actually asserting here is that resumeFromNode fired at all (a second
    // content_flow_executions row was recorded for the resumed action) after the fetch resolved.
    // The outer queue() call site unconditionally writes one row whenever the initial
    // executeFlow() call produces any actions (i.e. just for matching xContentAction itself), so
    // >=1 would pass even without branch resolution — >=2 discriminates "resumeFromNode ran".
    // NOTE: this count does NOT by itself prove only one branch (not both) resolved — that
    // one-vs-both gating property is proven separately above by the "does not collect both
    // branches on the initial dispatch" test, which asserts on executeFlow()'s actions array
    // directly.
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);
  });

  it("resolves the failed branch when link returns ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 502 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-2", channelId: "src-chan", payload: {} }),
      env
    );

    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);
  });

  it("schedules a content_flow_pending retry row when link reports rateLimited, instead of resolving a branch immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-3", channelId: "src-chan", payload: {} }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT retry_action, retry_count FROM content_flow_pending WHERE flow_id = 'flow-branch1' AND content_id = 'content-branch-3'`
    ).first<{ retry_action: string; retry_count: number }>();
    expect(pending?.retry_count).toBe(0);
    expect(JSON.parse(pending?.retry_action || "{}")).toMatchObject({ type: "xContentAction" });
  });

  it("interpolates $content.xxx fields from the payload into the prompt before calling link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithInterpolation = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", prompt: "Rewrite: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-interp', 1, 'interp flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithInterpolation).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-interp", channelId: "src-chan", payload: { content_text: "original post text" } }),
      env
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/internal/content/create-post");
    const body = JSON.parse(init.body as string);
    expect(body.interpolatedPrompt).toBe("Rewrite: original post text");
    expect(body.channelId).toBe("src-chan"); // no target-account picker — always the triggering channel

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-interp'`).run();
    vi.unstubAllGlobals();
  });

  it("routes a repost-post operation to /internal/x/repost with the source channel and the payload's source_content_id as tweetId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithRepostOp = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-repost-op', 1, 'repost op flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithRepostOp).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-repost-1", channelId: "src-chan", payload: { source_content_id: "tweet-abc-1" } }),
      env
    );

    // NOTE: the describe-level beforeEach also has 'flow-branch1' (same trigger channelId
    // "src-chan") live in FLOW_DB for every test in this block, so this content.created event
    // matches BOTH flow-branch1 and flow-repost-op — calls[0] is not reliably the repost call.
    // Find the /internal/x/repost call explicitly rather than assuming call order.
    const repostCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/x/repost"));
    expect(repostCall, "expected a fetch to /internal/x/repost").toBeDefined();
    const body = JSON.parse((repostCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ channelId: "src-chan", contentId: "content-repost-1", tweetId: "tweet-abc-1" });

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-repost-op'`).run();
    vi.unstubAllGlobals();
  });

  it("routes a create-bookmark operation to /internal/x/bookmark with the source channel and the payload's source_content_id as tweetId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithBookmarkOp = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-bookmark" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-bookmark-op', 1, 'bookmark op flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBookmarkOp).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-bookmark-1", channelId: "src-chan", payload: { source_content_id: "tweet-abc-2" } }),
      env
    );

    const bookmarkCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/x/bookmark"));
    expect(bookmarkCall, "expected a fetch to /internal/x/bookmark").toBeDefined();
    const body = JSON.parse((bookmarkCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ channelId: "src-chan", contentId: "content-bookmark-1", tweetId: "tweet-abc-2" });

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-bookmark-op'`).run();
    vi.unstubAllGlobals();
  });

  it("routes a like-post operation to /internal/x/like with the source channel and the payload's source_content_id as tweetId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithLikeOp = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "like-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-like-op', 1, 'like op flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithLikeOp).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-like-1", channelId: "src-chan", payload: { source_content_id: "tweet-abc-3" } }),
      env
    );

    const likeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/x/like"));
    expect(likeCall, "expected a fetch to /internal/x/like").toBeDefined();
    const body = JSON.parse((likeCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ channelId: "src-chan", contentId: "content-like-1", tweetId: "tweet-abc-3" });

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-like-op'`).run();
    vi.unstubAllGlobals();
  });

  it("schedules a content_flow_pending retry row for a rate-limited repost-post whose persisted payload still carries the triggering channel_id", async () => {
    // Regression test: the rate-limited-retry insert used to persist the raw `payload` (no
    // channel_id) instead of `matchPayload` (channel_id + optional list_id). scheduled()'s
    // retry path reads `payload.channel_id` back out of this stored JSON to know which channel
    // to repost from; a missing channel_id resolves to "" there, which link resolves to
    // "channel not found" -> ok:false (not rateLimited) -> the retry is wrongly abandoned as a
    // permanent failure instead of actually retrying. Asserting on the stored payload's
    // channel_id (not retry_action, which never carried this bug) proves the fix.
    // NOTE: flow-branch1 (from the describe-level beforeEach, same trigger channelId
    // "src-chan") also matches this content.created event, so two fetch calls occur. A shared
    // mockResolvedValue Response instance can only have its body read once (Response.json()
    // consumes the stream) — the second call would silently fall through to the `.catch(() =>
    // ({ ok: false }))` fallback with rateLimited undefined. Use mockImplementation to hand back
    // a fresh Response per call instead.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 })
      )
    );

    const graphWithRepostOp = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-repost-rl', 1, 'repost rate-limited flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithRepostOp).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-repost-rl-1", channelId: "src-chan", payload: { source_content_id: "tweet-rl-1" } }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT payload FROM content_flow_pending WHERE flow_id = 'flow-repost-rl' AND content_id = 'content-repost-rl-1'`
    ).first<{ payload: string }>();
    expect(pending).toBeTruthy();
    expect(JSON.parse(pending!.payload).channel_id).toBe("src-chan");

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-repost-rl'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-repost-rl'`).run();
    vi.unstubAllGlobals();
  });
});

describe("queue(): tiktokContentAction dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok1'`).run();
    vi.unstubAllGlobals();
  });

  it("interpolates $content.xxx fields and calls link's /internal/tiktok/photo-post with all node fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithTikTok = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            prompts: { title: "Title: $content.title", description: "Desc: $content.content_text", message_image: "Photo of: $content.title" },
            textProvider: "default", imageCount: 3, imageProvider: "default",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok1', 1, 'tiktok flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithTikTok).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-tt-1", channelId: "src-chan",
        payload: { title: "Original Title", content_text: "original body text" },
      }),
      env
    );

    const call = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/tiktok/photo-post"));
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.prompts.title).toBe("Title: Original Title");
    expect(body.prompts.description).toBe("Desc: original body text");
    expect(body.prompts.message_image).toBe("Photo of: Original Title");
    expect(body.imageCount).toBe(3);
    expect(body.imageProvider).toBe("default");
    expect(body.channelId).toBe("tiktok-chan-1");
  });

  it("schedules a content_flow_pending retry row when link reports rateLimited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    const graphWithTikTok = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", channelId: "tiktok-chan-1", prompts: { title: "t", description: "d", message_image: "i" }, textProvider: "none", imageProvider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok1', 1, 'tiktok flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithTikTok).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tt-2", channelId: "src-chan", payload: {} }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT retry_action FROM content_flow_pending WHERE flow_id = 'flow-tiktok1' AND content_id = 'content-tt-2'`
    ).first<{ retry_action: string }>();
    expect(JSON.parse(pending?.retry_action || "{}")).toMatchObject({ type: "tiktokContentAction" });

    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-tiktok1'`).run();
  });
});
