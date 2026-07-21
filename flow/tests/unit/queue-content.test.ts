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

  it("resolves failed immediately (no fetch to link) when attachVideo is true but payload has no processed_video_url", async () => {
    const graphVideoNoUrl = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
        { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
      ],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video-no-url', 1, 'video no url flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphVideoNoUrl).run();

    // The describe-level beforeEach also has 'flow-branch1' (same trigger channelId "src-chan")
    // live in FLOW_DB for every test in this block, so this content.created event ALSO matches
    // flow-branch1 and its own (non-video) xContentAction fires a real fetch call — fetchMock must
    // resolve to something usable (an unconfigured vi.fn() returns undefined, and flow-branch1's
    // code unconditionally awaits res.json(), throwing and aborting the whole queue message before
    // this test's own flow ever gets to record its content_flow_executions row).
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-no-url", channelId: "src-chan", payload: {} }),
      env
    );

    // Assert no call carried a videoUrl (rather than "zero calls total", since flow-branch1's own
    // call above is expected) — only an attachVideo:true action would ever include one, and this
    // test's own action must short-circuit before ever fetching.
    const anyCallWithVideoUrl = fetchMock.mock.calls.some(([, init]) => {
      const body = init && (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : {};
      return !!body.videoUrl;
    });
    expect(anyCallWithVideoUrl).toBe(false);
    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video-no-url'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-no-url'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-no-url'`).run();
    vi.unstubAllGlobals();
  });

  it("passes payload.processed_video_url as videoUrl to /internal/content/create-post when attachVideo is true", async () => {
    const graphVideo = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video-url', 1, 'video url flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphVideo).run();

    // mockImplementation (not mockResolvedValue) so flow-branch1's own concurrent call to the same
    // URL gets its own fresh Response instance, not a body already consumed by this flow's call.
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, id: "tweet-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-url", channelId: "src-chan", payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-9" } }),
      env
    );

    // flow-branch1 (same trigger channelId "src-chan") also calls /internal/content/create-post
    // for this event — find the call that actually carries a videoUrl, not just the first call to
    // this URL, since flow-branch1's own (non-video) call has no videoUrl and could come first.
    const createPostCall = fetchMock.mock.calls.find(([u, init]) => {
      if (!String(u).includes("/internal/content/create-post")) return false;
      const body = init && (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : {};
      return !!body.videoUrl;
    });
    expect(createPostCall).toBeDefined();
    const body = JSON.parse((createPostCall![1] as RequestInit).body as string);
    expect(body.videoUrl).toBe("https://content-dev.uni-scrm.com/public/media/vid-9");

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-url'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-url'`).run();
    vi.unstubAllGlobals();
  });

  it("inserts a content_flow_pending row with an xVideoStatusPoll retry_action when link returns pending:true, without resolving success/failed yet", async () => {
    const graphVideo = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      ],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video-pending', 1, 'video pending flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphVideo).run();

    // NOTE: the describe-level beforeEach also has 'flow-branch1' live in FLOW_DB (same trigger
    // channelId "src-chan"), so this content.created event matches BOTH flows and each dispatches
    // its own fetch call. mockResolvedValue would hand back the SAME Response instance to both
    // calls, and Response.json() can only consume a body once — the second caller would silently
    // get a used-body failure. Use mockImplementation so every call gets a fresh Response, matching
    // the same fix already applied to the pre-existing rate-limited-repost test above in this file.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ pending: true, mediaId: "media-9", channelId: "src-chan", text: "caption", checkAfterSecs: 5 }), { status: 200 })
    ));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-pending", channelId: "src-chan", payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-10" } }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT retry_action, retry_count, execute_at FROM content_flow_pending WHERE flow_id = 'flow-video-pending' AND content_id = 'content-video-pending'`
    ).first<{ retry_action: string; retry_count: number; execute_at: string }>();
    expect(pending).toBeTruthy();
    expect(pending!.retry_count).toBe(0);
    expect(JSON.parse(pending!.retry_action)).toMatchObject({ type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-9", text: "caption", nodeId: "a1" });
    expect(new Date(pending!.execute_at).getTime()).toBeGreaterThan(Date.now());

    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video-pending'`).first<{ c: number }>();
    // Only the initial dispatch row (matching the trigger) — no resumed-branch row yet, since
    // the branch hasn't resolved.
    expect(execCount?.c).toBe(1);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-pending'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-pending'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-video-pending'`).run();
    vi.unstubAllGlobals();
  });

  it("schedules a content_flow_pending wait row when a wait node follows the video xContentAction success branch", async () => {
    const graphVideoWithWait = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
        { id: "w1", type: "wait", data: { duration: 5, unit: "minutes" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "w1", sourceHandle: "success" },
      ],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video-with-wait', 1, 'video with wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphVideoWithWait).run();

    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-wait", channelId: "src-chan", payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-11" } }),
      env
    );

    // Query for the wait node pending row (awaiting_event is empty for timed wait)
    const waitRow = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, execute_at FROM content_flow_pending WHERE flow_id = 'flow-video-with-wait' AND content_id = 'content-video-wait' AND node_id = 'w1'`
    ).first<{ node_id: string; awaiting_event: string; execute_at: string }>();
    expect(waitRow).toBeTruthy();
    expect(waitRow!.node_id).toBe("w1");
    expect(new Date(waitRow!.execute_at).getTime()).toBeGreaterThan(Date.now());
    // Verify the wait is scheduled roughly 5 minutes (300000 ms) in the future
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeGreaterThan(299000);
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeLessThan(301000);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-with-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-with-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-video-with-wait'`).run();
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

  it("resolves failed immediately (no fetch) when operation is video-post but payload has no processed_video_url", async () => {
    const graphTiktokVideoNoUrl = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: { title: "t", description: "d" }, textProvider: "none" }, position: { x: 200, y: 0 } },
        { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
      ],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok-video-no-url', 1, 'tiktok video no url flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphTiktokVideoNoUrl).run();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tiktok-video-no-url", channelId: "src-chan", payload: {} }),
      env
    );

    expect(fetchMock).not.toHaveBeenCalled();

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok-video-no-url'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok-video-no-url'`).run();
    vi.unstubAllGlobals();
  });

  it("schedules a content_flow_pending wait row when a wait node follows the video-post tiktokContentAction failed branch (missing video)", async () => {
    const graphTiktokVideoWithFailedWait = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: { title: "t", description: "d" }, textProvider: "none" }, position: { x: 200, y: 0 } },
        { id: "w1", type: "wait", data: { duration: 5, unit: "minutes" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "w1", sourceHandle: "failed" },
      ],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok-video-failed-wait', 1, 'tiktok video failed wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphTiktokVideoWithFailedWait).run();

    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    ));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tiktok-video-failed-wait", channelId: "src-chan", payload: {} }),
      env
    );

    // Query for the wait node pending row (awaiting_event is empty for timed wait)
    const waitRow = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, execute_at FROM content_flow_pending WHERE flow_id = 'flow-tiktok-video-failed-wait' AND content_id = 'content-tiktok-video-failed-wait' AND node_id = 'w1'`
    ).first<{ node_id: string; awaiting_event: string; execute_at: string }>();
    expect(waitRow).toBeTruthy();
    expect(waitRow!.node_id).toBe("w1");
    expect(new Date(waitRow!.execute_at).getTime()).toBeGreaterThan(Date.now());
    // Verify the wait is scheduled roughly 5 minutes (300000 ms) in the future
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeGreaterThan(299000);
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeLessThan(301000);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok-video-failed-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok-video-failed-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-tiktok-video-failed-wait'`).run();
    vi.unstubAllGlobals();
  });

  it("routes operation:'video-post' to /internal/tiktok/video-post with the interpolated video URL, and 'photo-post' (default) still routes to /internal/tiktok/photo-post", async () => {
    const graphTiktokVideo = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: { title: "Title: $content.title", description: "Desc" }, textProvider: "none" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok-video', 1, 'tiktok video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphTiktokVideo).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tiktok-video", channelId: "src-chan", payload: { title: "My Title", processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-tt-1" } }),
      env
    );

    const videoPostCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/tiktok/video-post"));
    expect(videoPostCall).toBeDefined();
    const body = JSON.parse((videoPostCall![1] as RequestInit).body as string);
    expect(body.videoUrl).toBe("https://content-dev.uni-scrm.com/public/media/vid-tt-1");
    expect(body.prompts.title).toBe("Title: My Title");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/internal/tiktok/photo-post"))).toBe(false);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok-video'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok-video'`).run();
    vi.unstubAllGlobals();
  });
});

describe("queue(): videoCondition dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video1'`).run();
    vi.unstubAllGlobals();
  });

  function graphWithVideoCondition() {
    return JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: { operation: "check-face" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: -50 } },
        { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 50 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2", sourceHandle: "has-face" },
        { id: "e3", source: "a1", target: "a3", sourceHandle: "no-face" },
      ],
    });
  }

  it("calls content's /internal/detect-face with the payload's cover_image_url and resumes on the has-face branch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasFace: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-1", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    const call = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/detect-face"));
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.imageUrl).toBe("https://img/thumb.jpg");

    // The outer queue() call site unconditionally writes one row whenever the initial
    // executeFlow() call produces any actions (i.e. just for matching videoCondition itself), so
    // >=1 would pass even without branch resolution — >=2 discriminates "resumeFromNode ran and
    // resolved into a wired downstream node (a2, the has-face target)".
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);
  });

  it("resumes on the no-face branch when content's /internal/detect-face reports hasFace: false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasFace: false }), { status: 200 })));

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-2", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    // Same reasoning as the has-face test above: >=2 proves resumeFromNode resolved into a3 (the
    // no-face target), not just that the outer unconditional row for the initial match exists.
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-2'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);
  });

  it("resumes on the failed branch when content's /internal/detect-face returns a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Detection failed" }), { status: 502 })));

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-3", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    // DEVIATION FROM BRIEF: the brief's literal test body asserted
    // `expect(execution).toBeFalsy()` against a single-row SELECT. That can never pass: the
    // outer queue() call site (src/index.ts ~line 1005) unconditionally inserts ONE
    // content_flow_executions row whenever executeFlow()'s initial pass yields any action at
    // all — which it does here (the videoCondition node itself is the one action), regardless
    // of how the branch inside executeContentActions resolves. This exact masking behavior is
    // called out by this same file's xContentAction branch tests (see the comment above the
    // `>=2` assertion around line 176-188), which deliberately use a COUNT-based check instead
    // of truthy/falsy for this reason. Neither a2 (has-face) nor a3 (no-face) is wired to the
    // "failed" branch in this graph, so resumeFromNode's downstream resolution is empty and no
    // *second* (inner) row is written — the discriminator for "it went to failed" is exactly
    // ONE row (the outer one only), not zero.
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-3'`
    ).first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });

  it("resumes on the failed branch without calling content when cover_image_url is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-4", channelId: "src-chan",
        payload: {},
      }),
      env
    );

    const detectFaceCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/detect-face"));
    expect(detectFaceCall).toBeUndefined();
  });
});

describe("queue(): videoAction dispatch", () => {
  // Unlike xContentAction/tiktokContentAction/videoCondition above, videoAction's success
  // path does NOT resolve a branch synchronously — it dispatches to VIDEO_ACTION_QUEUE and
  // waits for content's queue consumer to call back into /internal/video-action/resume
  // (Task 11, not yet implemented). Only the two early-exit paths (duration cap, no video)
  // resolve "failed" synchronously here, so only those two get a2/a3 branch graphs.
  function graphWithVideoAction() {
    return JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "videoAction", targetLanguage: "zh" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: -50 } },
        { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 50 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
        { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
      ],
    });
  }

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-videoaction1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-videoaction1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-videoaction1'`).run();
    vi.unstubAllGlobals();
  });

  it("resolves the failed branch immediately (no link call, no queue dispatch) when payload.duration exceeds the 600s cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction1', 1, 'video action flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoAction()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-1", channelId: "src-chan",
        payload: { duration: 700 },
      }),
      testEnv as any
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();

    // Same discriminator used by the videoCondition/xContentAction tests above: the outer
    // queue() call site unconditionally writes one row for the initial match, so >=2 proves
    // resumeFromNode resolved into a3 (the wired "failed" target).
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);

    const pending = await env.FLOW_DB.prepare(
      `SELECT id FROM content_flow_pending WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-1'`
    ).first();
    expect(pending).toBeNull();
  });

  it("resolves the failed branch immediately (no queue dispatch) when link returns no video URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction1', 1, 'video action flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoAction()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-2", channelId: "src-chan",
        payload: {},
      }),
      testEnv as any
    );

    const call = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/content/video-url"));
    expect(call).toBeDefined();
    expect(queueSend).not.toHaveBeenCalled();

    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-2'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(2);

    // Minor symmetry fix: this graph has no wait node wired to the "failed" handle (a3 is a
    // plain noopLeaf), so resumed.pendingWaits is empty and no content_flow_pending row should
    // be written — mirrors the same assertion in the duration-cap test above.
    const pending = await env.FLOW_DB.prepare(
      `SELECT id FROM content_flow_pending WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-2'`
    ).first();
    expect(pending).toBeNull();
  });

  it("schedules a content_flow_pending wait row when a wait node follows videoAction's failed branch (duration cap exceeded)", async () => {
    // Same wait-drain bug class as the video xContentAction/tiktok tests above: a wait node
    // wired to videoAction's "failed" handle must get its content_flow_pending row scheduled
    // when resumeFromNode resolves into it, even though this is an early-exit synchronous path.
    const graphVideoActionWithFailedWait = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "videoAction", targetLanguage: "zh" }, position: { x: 200, y: 0 } },
        { id: "w1", type: "wait", data: { duration: 5, unit: "minutes" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "w1", sourceHandle: "failed" },
      ],
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction-failed-wait', 1, 'video action failed wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphVideoActionWithFailedWait).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-failed-wait", channelId: "src-chan",
        payload: { duration: 700 },
      }),
      testEnv as any
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();

    const waitRow = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, execute_at FROM content_flow_pending WHERE flow_id = 'flow-videoaction-failed-wait' AND content_id = 'content-va-failed-wait' AND node_id = 'w1'`
    ).first<{ node_id: string; awaiting_event: string; execute_at: string }>();
    expect(waitRow).toBeTruthy();
    expect(waitRow!.node_id).toBe("w1");
    expect(new Date(waitRow!.execute_at).getTime()).toBeGreaterThan(Date.now());
    // Verify the wait is scheduled roughly 5 minutes (300000 ms) in the future
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeGreaterThan(299000);
    expect(new Date(waitRow!.execute_at).getTime() - Date.now()).toBeLessThan(301000);

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-videoaction-failed-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-videoaction-failed-wait'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-videoaction-failed-wait'`).run();
  });

  it("enqueues a VIDEO_ACTION_QUEUE job and inserts a content_flow_pending row, without resolving success/failed yet, when link returns a video URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://youtube.com/watch?v=x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    // Deliberately use the both-branches graph (a2 wired to "success") rather than a graph with
    // no success edge at all — otherwise execCount === 1 below would hold trivially regardless
    // of whether the code resolves the success branch, since there'd be nothing to resolve into.
    // With a2 wired, execCount === 1 genuinely proves resumeFromNode was NOT called on the
    // success path (a2 never ran), which is the architectural property this test exists to check.
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction1', 1, 'video action flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoAction()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-3", channelId: "src-chan",
        payload: { source_content_id: "x" },
      }),
      testEnv as any
    );

    expect(queueSend).toHaveBeenCalledTimes(1);
    const message = queueSend.mock.calls[0][0];
    expect(message.videoUrl).toBe("https://youtube.com/watch?v=x");
    expect(message.targetLanguage).toBe("zh");
    expect(message.contentId).toBe("content-va-3");
    expect(message.nodeId).toBe("a1");

    const pending = await env.FLOW_DB.prepare(
      `SELECT node_id, awaiting_event, tenant_id FROM content_flow_pending WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-3'`
    ).first<{ node_id: string; awaiting_event: string; tenant_id: number }>();
    expect(pending).toBeTruthy();
    expect(pending!.node_id).toBe("a1");
    expect(pending!.awaiting_event).toBe("video_action_complete");
    expect(pending!.tenant_id).toBe(1);
    expect(message.pendingId).toBeTruthy();

    // Only the initial dispatch row — no resumed-branch row, since videoAction's success path
    // does not call resumeFromNode synchronously.
    const execCount = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-videoaction1' AND content_id = 'content-va-3'`
    ).first<{ c: number }>();
    expect(execCount?.c).toBe(1);
  });

  it("uses payload.processed_video_url as the video source and skips the link lookup, when chained from a prior Video Action node", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://youtube.com/watch?v=should-not-be-used" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction-chain', 1, 'chained video action flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoAction()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-chain", channelId: "src-chan",
        payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/rotated.mp4" },
      }),
      testEnv as any
    );

    expect(queueSend).toHaveBeenCalledTimes(1);
    const message = queueSend.mock.calls[0][0];
    expect(message.videoUrl).toBe("https://content-dev.uni-scrm.com/public/media/rotated.mp4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards operation in the VIDEO_ACTION_QUEUE message, defaulting to 'add-subtitle'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://youtube.com/watch?v=x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const queueSend = vi.fn();
    const testEnv = { ...env, VIDEO_ACTION_QUEUE: { send: queueSend } };

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-videoaction-op', 1, 'video action op flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoAction()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-va-op", channelId: "src-chan",
        payload: { source_content_id: "x" },
      }),
      testEnv as any
    );

    const message = queueSend.mock.calls[0][0];
    expect(message.operation).toBe("add-subtitle");
  });
});
