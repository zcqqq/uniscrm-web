import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 998;

const boundToLive = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-live" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const boundToGone = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" }, position: { x: 0, y: 0 } }],
  edges: [],
});

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

// authMiddleware fetches WEB_URL's /api/auth/me, and the route under test fetches LINK_URL's
// /internal/channels/active. One global stub serves both, routed by URL — a single catch-all
// response would feed the auth body to the channel lookup and vice versa.
function stubFetch(channels: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/internal/channels/active")) {
      if (channels === "throw") throw new Error("link down");
      return new Response(JSON.stringify(channels.body ?? {}), { status: channels.status });
    }
    return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
  }));
}

describe("GET /api/flows broken_trigger_type", () => {
  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory — create the
    // post-migration `flows` table by hand (0001_init as amended by 0011/0014/0015).
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-ok', ?, 'ok', ?, 'user', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToLive),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-broken', ?, 'broken', ?, 'user', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-draft', ?, 'draft', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  async function list() {
    const res = await worker.fetch(req("/api/flows"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string; broken_trigger_type: string | null; graph_json?: string }[] };
    return Object.fromEntries(body.flows.map((f) => [f.id, f]));
  }

  it("flags the published flow whose trigger channel is gone, and only that one", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBe("xTrigger");
    expect(byId["f-ok"].broken_trigger_type).toBeNull();
  });

  it("never flags a draft — publishing state is what makes the lie a lie", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-draft"].broken_trigger_type).toBeNull();
  });

  it("fails open when link is unreachable: nothing is flagged", async () => {
    stubFetch("throw");
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBeNull();
    expect(byId["f-ok"].broken_trigger_type).toBeNull();
  });

  it("fails open when link answers non-2xx", async () => {
    stubFetch({ status: 503 });
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBeNull();
  });

  it("does not ship graph_json to the browser", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-ok"].graph_json).toBeUndefined();
  });
});
