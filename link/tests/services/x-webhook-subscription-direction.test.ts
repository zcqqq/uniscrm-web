import { describe, it, expect, vi } from "vitest";
import { XActivityService } from "../../src/services/x-webhook";

// filter.direction 只在创建订阅时生效，之后既改不了也查不到：
//   - PUT /2/activity/subscriptions/{id} 只接受 tag 和 webhook_id
//   - GET /2/activity/subscriptions 返回的 filter 里没有 direction 字段
// 2026-08-09 dev 实测：15:26:06 新建的 like.create，请求带 direction:"inbound"，**创建响应
// 回显了** direction，列表接口却查不到。所以「比对列表和 metadata、发现不一致就重建」是
// 做不到的——那样会把一条完全正确的订阅每轮删了重建，永不收敛。换方向只能显式重建。

describe("XActivityService.deleteSubscription", () => {
  it("打 DELETE /2/activity/subscriptions/{id}", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 }));
    }));

    // 这个 token 必须是 app-only bearer：DELETE 只收 app-only，用户 token 会被 403
    // "Unsupported Authentication ... Supported authentication types are [OAuth 2.0
    // Application-Only]"（2026-08-09 dev 实测）——而建订阅的要求恰好相反。
    await new XActivityService("app-bearer").deleteSubscription("sub-42");

    expect(calls[0].url).toBe("https://api.x.com/2/activity/subscriptions/sub-42");
    expect(calls[0].init?.method).toBe("DELETE");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer app-bearer");
  });

  it("404 视为已删除——目标状态已经达成，不该让整轮修复失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(new XActivityService("app-bearer").deleteSubscription("gone")).resolves.toBeUndefined();
  });

  it("HTTP 200 但 deleted:false 也要抛——静默失败会让调用方以为可以安全重建", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { deleted: false } }), { status: 200 }),
    ));
    await expect(new XActivityService("app-bearer").deleteSubscription("stuck")).rejects.toThrow("deleted:false");
  });

  it("其它错误码照常抛", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(new XActivityService("app-bearer").deleteSubscription("x")).rejects.toThrow("500");
  });
});

describe("createSubscription — direction 传递", () => {
  it("把 metadata 的 direction 放进 filter，X 在创建响应里回显它", async () => {
    // 回显是我们唯一能确认 X 收下了 direction 的地方，列表接口不返回它。
    let sent: { filter?: unknown } = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({
        data: { subscription: { subscription_id: "s1", filter: { user_id: "u1", direction: "inbound" } } },
      }), { status: 200 }));
    }));

    const id = await new XActivityService("user-token").createSubscription("like.create", "u1", "wh-1", "inbound");

    expect(id).toBe("s1");
    expect(sent.filter).toEqual({ user_id: "u1", direction: "inbound" });
  });
});
