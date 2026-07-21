import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 999;

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
// A content flow whose only trigger was deleted. Before migration 0014 the list query
// sniffed graph_json, so this row silently moved into the User Flow list.
const triggerlessGraph = JSON.stringify({ nodes: [{ id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 0, y: 0 } }], edges: [] });

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

// GET /api/flows is behind authMiddleware, which calls WEB_URL's /api/auth/me over fetch
// and c.set()s tenantId/memberId from the response. We stub global fetch so that call
// resolves to a fixed tenant/member, matching the tenant_id used by the fixture rows below,
// then call the real worker.fetch(...) so this test actually exercises flow/src/index.ts's
// GET /api/flows domain-filter SQL rather than re-implementing/hardcoding it here.
describe("GET /api/flows domain filter", () => {
  beforeEach(async () => {
    // authMiddleware runs for both the "/api/flows" and "/api/flows/*" registrations, which
    // both match this path and so invoke the mocked fetch (and read its body) more than once
    // per request -- return a fresh Response each call rather than a single shared instance.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 })
      )
    );

    // vitest-pool-workers does not auto-apply this module's migrations/ directory (see
    // queue-content.test.ts beforeEach for the same note) -- create the post-migration
    // `flows` table by hand, matching migrations/0001_init.sql as amended by
    // 0011_drop_enabled.sql (which removed flows.enabled) and 0014_flows_domain.sql.
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY,
         tenant_id INTEGER NOT NULL,
         member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow',
         description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
         domain TEXT NOT NULL DEFAULT 'user',
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

    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('f-user', ?, 'u', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('f-content', ?, 'c', ?, 'content', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentFlowGraph),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("domain=content returns only the content-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows?domain=content"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string }[] };
    expect(body.flows.map((f) => f.id)).toEqual(["f-content"]);
  });

  it("domain=user (default) returns only the user-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string }[] };
    expect(body.flows.map((f) => f.id)).toEqual(["f-user"]);
  });

  it("keeps a content flow in the content list after its only trigger is deleted", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('f-triggerless', ?, 'no trigger', ?, 'content', 'draft', datetime('now'), datetime('now'))`
    ).bind(TENANT_ID, triggerlessGraph).run();

    const contentRes = await worker.fetch(req("/api/flows?domain=content"), env);
    const contentBody = await contentRes.json() as { flows: { id: string }[] };
    expect(contentBody.flows.map((f) => f.id).sort()).toEqual(["f-content", "f-triggerless"]);

    const userRes = await worker.fetch(req("/api/flows"), env);
    const userBody = await userRes.json() as { flows: { id: string }[] };
    expect(userBody.flows.map((f) => f.id)).toEqual(["f-user"]);
  });

  it("stores the domain given at creation", async () => {
    const createRes = await worker.fetch(
      new Request("https://flow.test/api/flows", {
        method: "POST",
        headers: { Cookie: "session=test", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fresh", domain: "content" }),
      }),
      env
    );
    expect(createRes.status).toBe(201);
    const { flow } = await createRes.json() as { flow: { id: string; domain: string } };
    expect(flow.domain).toBe("content");

    const row = await env.FLOW_DB.prepare(`SELECT domain FROM flows WHERE id = ?`)
      .bind(flow.id).first<{ domain: string }>();
    expect(row?.domain).toBe("content");
  });

  it("defaults a creation without an explicit domain to user", async () => {
    const createRes = await worker.fetch(
      new Request("https://flow.test/api/flows", {
        method: "POST",
        headers: { Cookie: "session=test", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fresh" }),
      }),
      env
    );
    expect(createRes.status).toBe(201);
    const { flow } = await createRes.json() as { flow: { domain: string } };
    expect(flow.domain).toBe("user");
  });
});
