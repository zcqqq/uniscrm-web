import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function app(row: Record<string, unknown> | null, tenantId = 7) {
  const a = new Hono();
  a.use("*", async (c, next) => { c.set("tenantId" as never, tenantId as never); await next(); });
  a.route("/api/channels", channelsRoutes());
  const db = {
    prepare: () => ({ bind: () => ({ first: async () => row }) }),
  } as unknown as D1Database;
  return a.request("http://x/api/channels/github/repos", {}, { LINK_DB: db } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/channels/github/repos", () => {
  it("没连 GitHub 时返回 connected:false，不打外部 API", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await app(null);
    expect(await res.json()).toEqual({ connected: false, accountChannelId: null, repos: [] });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("实时拉取 Watch 列表并按 fullName 排序", async () => {
    // 实时拉、不吃快照：刚 Watch 的 repo 要立刻出现在 flow 选择器里
    const fetchStub = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify([
        { id: 2, full_name: "z/beta", name: "beta", description: "b", private: false },
        { id: 1, full_name: "a/alpha", name: "alpha", description: null, private: false },
      ]), { status: 200 }))
    );
    vi.stubGlobal("fetch", fetchStub);
    const res = await app({ id: "chan-1", config: JSON.stringify({ access_token: "tok", login: "zc" }) });
    const body = await res.json<{ accountChannelId: string; login: string | null; repos: { fullName: string }[] }>();
    expect(body.accountChannelId).toBe("chan-1");
    // 账号块要显示的是人能认出来的用户名，不是一串 channel UUID。
    expect(body.login).toBe("zc");
    expect(body.repos.map((r) => r.fullName)).toEqual(["a/alpha", "z/beta"]);
    // Verify correct token was forwarded
    expect(fetchStub).toHaveBeenCalled();
    const authHeader = (fetchStub.mock.calls[0][1] as RequestInit)?.headers as Record<string, string> | undefined;
    expect(authHeader?.Authorization).toBe("Bearer tok");
  });

  it("config 里没有 login 的老渠道回 null，而不是漏掉这个字段或塞 undefined", async () => {
    // 前端据此退回「已连接账号」的通用文案；字段缺失与 null 在类型上是两回事，别让它漂。
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    ));
    const res = await app({ id: "chan-1", config: JSON.stringify({ access_token: "tok" }) });
    const body = await res.json<Record<string, unknown>>();
    expect("login" in body).toBe(true);
    expect(body.login).toBeNull();
  });

  it("GitHub 报错时返回 502 而不是空列表 —— 空列表会被误读成「你没 Watch 任何 repo」", async () => {
    // Stub fetch to return an error status, causing listWatchedRepos to throw
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ));
    const res = await app({ id: "chan-1", config: JSON.stringify({ access_token: "tok" }) });
    // Verify the response is 502, not a 200 with empty repos
    expect(res.status).toBe(502);
  });
});
