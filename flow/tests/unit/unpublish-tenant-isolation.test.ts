import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// The session's tenant is whatever the mocked /auth/me returns. Each test sets
// ATTACKER_TENANT as the caller and checks it cannot reach VICTIM_TENANT's rows.
const ATTACKER_TENANT = 501;
const VICTIM_TENANT = 502;

function req(path: string) {
  return new Request(`https://flow.test${path}`, { method: "POST", headers: { Cookie: "session=test" } });
}

describe("POST /api/flows/:id/unpublish — tenant isolation", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(ATTACKER_TENANT) } }), { status: 200 })
    ));

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_pending (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL DEFAULT '',
         user_id TEXT NOT NULL DEFAULT '', tenant_id INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '',
         execute_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT ''
       )`
    ).run();
    await env.WEB_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
         tenant_id INTEGER PRIMARY KEY, email TEXT NOT NULL, d1_database_id TEXT, created_at TEXT NOT NULL
       )`
    ).run();
    await env.WEB_DB.prepare(
      `INSERT OR IGNORE INTO tenants (tenant_id, email, d1_database_id, created_at) VALUES (?, 'a@x.com', 'db-a', datetime('now'))`
    ).bind(ATTACKER_TENANT).run();

    // The victim owns a published flow with a pending execution queued.
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, status, created_at, updated_at) VALUES ('victim-flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(VICTIM_TENANT).run();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flow_pending (id, flow_id, tenant_id, created_at) VALUES ('pending-1', 'victim-flow', ?, datetime('now'))`
    ).bind(VICTIM_TENANT).run();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.FLOW_DB.prepare("DELETE FROM flow_pending").run();
    await env.FLOW_DB.prepare("DELETE FROM flows").run();
  });

  it("returns 404 and leaves the victim's flow_pending intact", async () => {
    const res = await worker.fetch(req("/api/flows/victim-flow/unpublish"), env);
    expect(res.status).toBe(404);

    const pending = await env.FLOW_DB.prepare("SELECT COUNT(*) AS n FROM flow_pending WHERE flow_id = 'victim-flow'")
      .first<{ n: number }>();
    expect(pending?.n).toBe(1);

    const flow = await env.FLOW_DB.prepare("SELECT status FROM flows WHERE id = 'victim-flow'")
      .first<{ status: string }>();
    expect(flow?.status).toBe("published"); // untouched
  });

  it("still unpublishes and clears flow_pending for the caller's own flow", async () => {
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, status, created_at, updated_at) VALUES ('own-flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(ATTACKER_TENANT).run();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flow_pending (id, flow_id, tenant_id, created_at) VALUES ('own-pending', 'own-flow', ?, datetime('now'))`
    ).bind(ATTACKER_TENANT).run();

    const res = await worker.fetch(req("/api/flows/own-flow/unpublish"), env);
    expect(res.status).toBe(200);

    const pending = await env.FLOW_DB.prepare("SELECT COUNT(*) AS n FROM flow_pending WHERE flow_id = 'own-flow'")
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);

    const flow = await env.FLOW_DB.prepare("SELECT status FROM flows WHERE id = 'own-flow'")
      .first<{ status: string }>();
    expect(flow?.status).toBe("draft");
  });
});
