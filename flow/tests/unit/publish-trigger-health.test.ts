import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 997;

const boundToLive = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-live" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const boundToGone = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const cronOnly = JSON.stringify({
  nodes: [{ id: "t1", type: "cronTrigger", data: { scheduleType: "daily", dailyTime: "09:00" }, position: { x: 0, y: 0 } }],
  edges: [],
});

function publishReq(id: string) {
  return new Request(`https://flow.test/api/flows/${id}/publish`, {
    method: "POST",
    headers: { Cookie: "session=test" },
  });
}

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

async function statusOf(id: string) {
  const row = await env.FLOW_DB.prepare(`SELECT status FROM flows WHERE id = ?`).bind(id).first<{ status: string }>();
  return row?.status;
}

describe("POST /api/flows/:id/publish trigger gate", () => {
  beforeEach(async () => {
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
         VALUES ('p-ok', ?, 'ok', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToLive),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-broken', ?, 'broken', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-cron', ?, 'cron', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, cronOnly),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("publishes a flow whose trigger channel is active", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(200);
    expect(await statusOf("p-ok")).toBe("published");
  });

  it("refuses to publish a flow whose trigger channel is gone, and leaves it a draft", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-broken"), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("X account");
    expect(await statusOf("p-broken")).toBe("draft");
  });

  it("aborts with 503 when link cannot be reached — never publishes unverified", async () => {
    stubFetch("throw");
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(503);
    expect(await statusOf("p-ok")).toBe("draft");
  });

  it("aborts with 503 when link answers non-2xx", async () => {
    stubFetch({ status: 500 });
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(503);
    expect(await statusOf("p-ok")).toBe("draft");
  });

  it("publishes a cronTrigger flow without consulting link at all", async () => {
    stubFetch("throw");
    const res = await worker.fetch(publishReq("p-cron"), env);
    expect(res.status).toBe(200);
    expect(await statusOf("p-cron")).toBe("published");
  });

  it("still 404s on another tenant's flow", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
       VALUES ('p-other', 12345, 'other', ?, 'user', 'draft', datetime('now'), datetime('now'))`
    ).bind(boundToLive).run();
    const res = await worker.fetch(publishReq("p-other"), env);
    expect(res.status).toBe(404);
    expect(await statusOf("p-other")).toBe("draft");
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'p-other'`).run();
  });
});
