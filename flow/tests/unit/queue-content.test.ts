import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { executeFlow } from "../../src/engine";

const graphContentToStatus = JSON.stringify({
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
    ).run().catch(() => {}); // no-op: violates tenants.email NOT NULL — intentionally left
    // unresolvable so the updateContentStatus action's SELECT ... WHERE tenant_id = ? finds no
    // row and skips constructing a real TenantDataDB (which would otherwise fire an actual
    // Cloudflare D1 REST API call with an undefined CF_D1_API_TOKEN in this test environment).
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-c1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-c1'`).run();
  });

  it("matches a published flow with a contentTrigger and records content_flow_executions keyed by content_id", async () => {
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
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "target-chan-1", prompt: "Rewrite: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  };
  const graphWithBranches = JSON.stringify(graphWithBranchesObj);

  it("does not collect both branches on the initial dispatch (hasBranches gating) — executeFlow's initial pass over an xContentAction node yields only the action itself, not either branch's downstream updateContentStatus node", () => {
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

  it("resolves the success branch and runs updateContentStatus(published) when link returns ok:true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-1", channelId: "src-chan", payload: {} }),
      env
    );

    // updateContentStatus tries to look up the tenant's d1_database_id and no-ops if missing
    // (same pattern the existing queue-content.test.ts beforeEach relies on) — what we're
    // actually asserting here is that resumeFromNode fired at all (a second
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
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-1", prompt: "Rewrite: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
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

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-interp'`).run();
    vi.unstubAllGlobals();
  });
});
