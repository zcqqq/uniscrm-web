import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../../src/routes-channels";
import type { Env } from "../../src/types";

// 组一个最小的 app：注入 tenantId / tenantDataDb，挂上被测路由。
// channelsRoutes() 返回一个 Hono<{ Bindings: Env }> 路由器（src/routes-channels.ts:19）。
function createApp(opts: {
  channelRow: Record<string, unknown> | null;
  tenantDataDb?: { query: ReturnType<typeof vi.fn> };
}) {
  const LINK_DB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(opts.channelRow),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
  };
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 42 as never);
    c.set("tenantDataDb" as never, opts.tenantDataDb as never);
    await next();
  });
  app.route("/", channelsRoutes());
  const env = { LINK_DB, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs" } as unknown as Env;
  return { app, env };
}

const ACCOUNT_ROW = {
  id: "acct-1",
  created_at: "2026-07-01T00:00:00.000Z",
  config: JSON.stringify({
    email: "a@b.com",
    channel_title: "My Channel",
    sync_status: "done",
    access_token: "tok",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    // 故意留一份旧快照：路由绝不能再读它
    subscriptions: [{ channelId: "STALE", channelName: "stale", thumbnailUrl: "" }],
  }),
};

describe("GET /youtube/subscriptions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("实时拉取，不读 config.subscriptions 里的旧快照", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      items: [{ snippet: { resourceId: { channelId: "UC1" }, title: "Fresh", thumbnails: { default: { url: "u" } } } }],
    }), { status: 200 }));
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW });

    const res = await app.request("/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.subscriptions).toEqual([{ channelId: "UC1", channelName: "Fresh", thumbnailUrl: "u" }]);
    expect(JSON.stringify(body)).not.toContain("STALE");
    // 响应结构与改动前一致 —— flow 前端零改动的前提
    expect(body).toMatchObject({ connected: true, accountChannelId: "acct-1", email: "a@b.com" });
  });

  it("未连接时返回空列表", async () => {
    const { app, env } = createApp({ channelRow: null });
    const body = await (await app.request("/youtube/subscriptions", {}, env)).json() as any;
    expect(body).toEqual({ connected: false, accountChannelId: null, subscriptions: [] });
  });

  it("YouTube API 失败时返回空列表而不是 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW });

    const res = await app.request("/youtube/subscriptions", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).subscriptions).toEqual([]);
  });
});

describe("GET /youtube/status", () => {
  it("subscription_count 来自 per-tenant D1 的 user 表，不是 config 快照", async () => {
    const query = vi.fn().mockResolvedValue([{ c: 7 }]);
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW, tenantDataDb: { query } });

    const body = await (await app.request("/youtube/status", {}, env)).json() as any;

    expect(body.subscription_count).toBe(7);
    expect(String(query.mock.calls[0][0])).toContain("is_follow = 1");
    expect(String(query.mock.calls[0][0])).toContain("channel_type");
    expect(body).toMatchObject({ connected: true, email: "a@b.com", channel_title: "My Channel", sync_status: "done" });
  });

  it("租户 D1 未 provision 时计数为 0，且仍是 200", async () => {
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW, tenantDataDb: undefined });
    const res = await app.request("/youtube/status", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).subscription_count).toBe(0);
  });
});
