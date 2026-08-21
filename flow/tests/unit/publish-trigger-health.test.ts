import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { seedSession } from "./helpers/seed-session";

const TENANT_ID = 997;

const boundToLive = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-live" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const boundToGone = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" }, position: { x: 0, y: 0 } }],
  edges: [],
});
// GitHub 触发器：账号连着，但一个 repo 都没选 —— 发布得了却永远不触发。
const githubNoRepo = JSON.stringify({
  nodes: [{ id: "t1", type: "githubContentTrigger", data: { channelId: "chan-live", repos: [] }, position: { x: 0, y: 0 } }],
  edges: [],
});
const githubWithRepo = JSON.stringify({
  nodes: [{ id: "t1", type: "githubContentTrigger", data: { channelId: "chan-live", repos: [{ fullName: "oven-sh/bun" }] }, position: { x: 0, y: 0 } }],
  edges: [],
});
// 生产真实形态（租户 100001，flow f701b9fe）：模板把每个节点的 channelId 都留成 ""，
// 用户补齐了 action 节点，唯独 trigger 没补。运行时 TRIGGER_MATCHERS 拿 "" 去比真实
// channel id，这条 flow 发布成功、显示"已发布"、一次都没触发过。
const triggerNoChannel = JSON.stringify({
  nodes: [
    { id: "t1", type: "xTrigger", data: { channelType: "X", eventType: "follow.follow", channelId: "" }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "xAction", xEvent: "create-dm", channelId: "chan-live" }, position: { x: 320, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});
const contentTriggerNoChannel = JSON.stringify({
  nodes: [{ id: "t1", type: "xContentTrigger", data: { channelId: "", mode: "get-list-posts", listId: "l1" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const cronOnly = JSON.stringify({
  nodes: [{ id: "t1", type: "cronTrigger", data: { scheduleType: "daily", dailyTime: "09:00" }, position: { x: 0, y: 0 } }],
  edges: [],
});

function publishReq(id: string) {
  return new Request(`https://flow.test/api/flows/${id}/publish`, {
    method: "POST",
    headers: { Cookie: `session=sess-${TENANT_ID}` },
  });
}

function stubFetch(channels: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/internal/channels/active")) {
      if (channels === "throw") throw new Error("link down");
      return new Response(JSON.stringify(channels.body ?? {}), { status: channels.status });
    }
    // authMiddleware resolves sessions from WEB_DB (shared/auth.ts) — no auth fetch anymore.
    throw new Error(`unexpected fetch call in test: ${url}`);
  }));
}

async function statusOf(id: string) {
  const row = await env.FLOW_DB.prepare(`SELECT status FROM flows WHERE id = ?`).bind(id).first<{ status: string }>();
  return row?.status;
}

describe("POST /api/flows/:id/publish trigger gate", () => {
  beforeEach(async () => {
    await seedSession(env as never, `sess-${TENANT_ID}`, TENANT_ID);
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
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-gh-empty', ?, 'gh empty', ?, 'content', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, githubNoRepo),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-gh-ok', ?, 'gh ok', ?, 'content', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, githubWithRepo),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-no-chan', ?, 'no chan', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, triggerNoChannel),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-content-no-chan', ?, 'content no chan', ?, 'content', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentTriggerNoChannel),
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

  // 前端的 findGitHubTriggerNoRepoIds 只挡住 UI 那条路径；直连 API 发布必须同样被挡，
  // 否则 flow 会显示 published 却永远不触发。
  it("refuses to publish a githubContentTrigger with no repository selected, and leaves it a draft", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-gh-empty"), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("repository");
    expect(await statusOf("p-gh-empty")).toBe("draft");
  });

  it("publishes a githubContentTrigger that has at least one repository", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-gh-ok"), env);
    expect(res.status).toBe(200);
    expect(await statusOf("p-gh-ok")).toBe("published");
  });

  // 这一组是 2026-08-21 那次排查的回归：租户 100001 唯一一条 published flow 的 trigger
  // 没选账号，从 2026-07-25 起一次都没触发，flow_log / credit_usage_log 全空。
  it("refuses to publish an xTrigger with no account selected, and leaves it a draft", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-no-chan"), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    // "没选账号"必须与 findBrokenTrigger 的"选的那个账号断了"说成两句话：后者会把用户
    // 打发去 Channels 页重连一个连得好好的账号。
    expect(body.error).toContain("no X account selected");
    expect(body.error).not.toContain("not connected");
    expect(await statusOf("p-no-chan")).toBe("draft");
  });

  it("refuses an xContentTrigger with no account selected too", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-content-no-chan"), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("no X account selected");
    expect(await statusOf("p-content-no-chan")).toBe("draft");
  });

  // 纯本地判据，排在问 link 之前 —— link 挂着的时候也拦得住，而且不会退化成 503
  // "验证不了、请重试"，那会把用户指向一个跟他的问题无关的方向。
  it("catches the missing account even when link is unreachable — 400, not 503", async () => {
    stubFetch("throw");
    const res = await worker.fetch(publishReq("p-no-chan"), env);
    expect(res.status).toBe(400);
    expect(await statusOf("p-no-chan")).toBe("draft");
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
