import { describe, it, expect, vi, beforeEach } from "vitest";

// api.ts 只经 authFetch 出网，把它换掉就能数出真正发了几次请求。
const stub = vi.hoisted(() => ({ urls: [] as string[], failNext: 0 }));
vi.mock("../../../shared/frontend/lib/auth-fetch", () => ({
  authFetch: async (url: string) => {
    stub.urls.push(url);
    if (stub.failNext > 0) {
      stub.failNext--;
      return new Response(JSON.stringify({ error: "upstream" }), {
        status: 502,
        // i18n-ok: HTTP header name/value, not user-facing text
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([{ id: `c${stub.urls.length}`, username: "acct" }]), {
      status: 200,
      // i18n-ok: HTTP header name/value, not user-facing text
      headers: { "Content-Type": "application/json" },
    });
  },
}));

import { api } from "../../frontend/lib/api";
import { useFlowEditor } from "../../frontend/store/flow-editor";

describe("channels.listCached 的记忆化与显式作废", () => {
  beforeEach(() => {
    stub.urls.length = 0;
    stub.failNext = 0;
    api.channels.invalidateListCache();
  });

  it("同一 channelType 的并发调用共用一条 promise，只发一次请求", async () => {
    const first = api.channels.listCached("X");
    const second = api.channels.listCached("X");
    // 记忆化要留着：多个 Inspector 同时挂载时不该对同一个 /api/channels 发 N 次请求。
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(stub.urls).toEqual(["/api/channels?type=X"]);
  });

  it("作废之后下一次调用真的重新发请求，而不是把记忆化的 promise 递回来", async () => {
    const before = await api.channels.listCached("X");
    expect(stub.urls.length).toBe(1);

    api.channels.invalidateListCache("X");

    const after = await api.channels.listCached("X");
    // 没有作废入口时这里是 1 —— 用户在别的页面连了新渠道再切回编辑器，
    // 账号下拉框会一直是老的那一组，直到整页刷新。
    expect(stub.urls.length).toBe(2);
    expect(after).not.toEqual(before);
  });

  it("只作废指定的 channelType，不误伤别的", async () => {
    await api.channels.listCached("X");
    await api.channels.listCached("TIKTOK");
    expect(stub.urls.length).toBe(2);

    api.channels.invalidateListCache("X");
    await api.channels.listCached("TIKTOK");
    expect(stub.urls.length).toBe(2);
    await api.channels.listCached("X");
    expect(stub.urls.length).toBe(3);
  });

  it("不传参数则全部作废", async () => {
    await api.channels.listCached("X");
    await api.channels.listCached("TIKTOK");
    expect(stub.urls.length).toBe(2);

    api.channels.invalidateListCache();
    await api.channels.listCached("X");
    await api.channels.listCached("TIKTOK");
    expect(stub.urls.length).toBe(4);
  });

  it("作废未知的 channelType 不报错", () => {
    expect(() => api.channels.invalidateListCache("NOPE")).not.toThrow();
  });

  it("取数失败要 reject，不能悄悄变成空数组", async () => {
    stub.failNext = 1;
    // 回空数组的话调用方只能渲染成"尚未绑定账号"，而用户该做的是重试。
    await expect(api.channels.listCached("X")).rejects.toThrow();
  });

  it("失败的 promise 不留在缓存里：下一次调用重新发请求并能成功", async () => {
    stub.failNext = 1;
    await expect(api.channels.listCached("X")).rejects.toThrow();
    expect(stub.urls.length).toBe(1);

    // 这是本次修的核心：一次瞬时 502 曾被记忆化成"整场会话都没有账号"，
    // 用户被告知去绑定一个他早就绑好的账号，且整页刷新之前翻不了身。
    const ok = await api.channels.listCached("X");
    expect(stub.urls.length).toBe(2);
    expect(ok).toEqual([{ id: "c2", username: "acct" }]);
  });

  it("失败不会连累别的 channelType 的缓存", async () => {
    const tiktok = await api.channels.listCached("TIKTOK");
    stub.failNext = 1;
    await expect(api.channels.listCached("X")).rejects.toThrow();

    expect(await api.channels.listCached("TIKTOK")).toEqual(tiktok);
    expect(stub.urls.length).toBe(2); // TIKTOK 第二次仍然命中缓存
  });
});

describe("autoFillChannelIds", () => {
  beforeEach(() => {
    stub.urls.length = 0;
    stub.failNext = 0;
    api.channels.invalidateListCache();
  });

  it("listCached 失败时不抛错、也不改图", async () => {
    // listCached 现在会 reject。自动填充是加载 flow 时的尽力而为，一旦让这个
    // rejection 冒出去，EditorPage 里那两处 void autoFillChannelIds() 就是
    // unhandled rejection，而这是 flow 打开时的必经路径。
    useFlowEditor.setState({
      nodes: [{ id: "n1", type: "action", position: { x: 0, y: 0 }, data: { actionType: "xAction" } }] as never,
      edges: [],
      isDirty: false,
    });
    stub.failNext = 1;

    await expect(useFlowEditor.getState().autoFillChannelIds()).resolves.toBeUndefined();
    // 取不到就当"不知道有哪些账号"，绝不能凭空判定"只有一个账号"去写 channelId。
    expect((useFlowEditor.getState().nodes[0].data as Record<string, unknown>).channelId).toBeUndefined();
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("成功且只有一个账号时才自动填充", async () => {
    useFlowEditor.setState({
      nodes: [{ id: "n1", type: "action", position: { x: 0, y: 0 }, data: { actionType: "xAction" } }] as never,
      edges: [],
      isDirty: false,
    });

    await useFlowEditor.getState().autoFillChannelIds();
    expect((useFlowEditor.getState().nodes[0].data as Record<string, unknown>).channelId).toBe("c1");
  });

  // 2026-08-21 排查：这一段此前只看 node.type === "action"，trigger 一律跳过。模板给出的图
  // 里每个节点的 channelId 都是 ""，于是 action 被补齐、trigger 留空 —— 发布成功、显示
  // "已发布"、一次都不触发（生产租户 100001 的 flow f701b9fe 正是这样）。
  it("channel-bound trigger 也要自动填充，不只是 action", async () => {
    useFlowEditor.setState({
      nodes: [
        { id: "t1", type: "xTrigger", position: { x: 0, y: 0 }, data: { channelType: "X", eventType: "follow.follow", channelId: "" } },
        { id: "a1", type: "action", position: { x: 320, y: 0 }, data: { actionType: "xAction", xEvent: "create-dm", channelId: "" } },
      ] as never,
      edges: [],
      isDirty: false,
    });

    await useFlowEditor.getState().autoFillChannelIds();
    const [t1, a1] = useFlowEditor.getState().nodes;
    expect((t1.data as Record<string, unknown>).channelId).toBe("c1");
    expect((a1.data as Record<string, unknown>).channelId).toBe("c1");
    // trigger 和 action 同属 "X"，只该问一次账号列表。
    expect(stub.urls).toEqual(["/api/channels?type=X"]);
  });

  it("xContentTrigger 的 channelType 固定为 X（它的 data 里没有 channelType 这一格）", async () => {
    useFlowEditor.setState({
      nodes: [{ id: "t1", type: "xContentTrigger", position: { x: 0, y: 0 }, data: { channelId: "", mode: "get-list-posts" } }] as never,
      edges: [],
      isDirty: false,
    });

    await useFlowEditor.getState().autoFillChannelIds();
    expect((useFlowEditor.getState().nodes[0].data as Record<string, unknown>).channelId).toBe("c1");
    expect(stub.urls).toEqual(["/api/channels?type=X"]);
  });

  // cronTrigger 不绑账号；youtube/github trigger 的账号来自它们各自的端点
  // （youtubeSubscriptions / githubRepos 的 accountChannelId），不是 /api/channels。
  // 为它们发一次 /api/channels?type=undefined 只会白打一个 404。
  it("不给 cronTrigger / youtube / github trigger 发请求", async () => {
    useFlowEditor.setState({
      nodes: [
        { id: "t1", type: "cronTrigger", position: { x: 0, y: 0 }, data: { scheduleType: "daily" } },
        { id: "t2", type: "youtubeContentTrigger", position: { x: 0, y: 0 }, data: { channelId: "", subscriptions: [] } },
        { id: "t3", type: "githubContentTrigger", position: { x: 0, y: 0 }, data: { channelId: "", repos: [] } },
      ] as never,
      edges: [],
      isDirty: false,
    });

    await useFlowEditor.getState().autoFillChannelIds();
    expect(stub.urls).toEqual([]);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("trigger 已经选了账号就不覆盖", async () => {
    useFlowEditor.setState({
      nodes: [{ id: "t1", type: "xTrigger", position: { x: 0, y: 0 }, data: { channelType: "X", channelId: "already-picked" } }] as never,
      edges: [],
      isDirty: false,
    });

    await useFlowEditor.getState().autoFillChannelIds();
    expect((useFlowEditor.getState().nodes[0].data as Record<string, unknown>).channelId).toBe("already-picked");
    expect(stub.urls).toEqual([]);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("不参与作废：仍走记忆化，不调用 invalidateListCache", async () => {
    // 它是加载 flow 时的后台便利逻辑，没有任何用户可见的"刷新"入口；在那里作废缓存
    // 只会把这份缓存本来要挡的并发重复请求放回来。用户点了别处的刷新按钮之后，
    // 它下一次调用自然就拿到新数据了。
    await api.channels.listCached("X");
    expect(stub.urls.length).toBe(1);

    useFlowEditor.setState({
      nodes: [{ id: "n1", type: "action", position: { x: 0, y: 0 }, data: { actionType: "xAction" } }] as never,
      edges: [],
      isDirty: false,
    });
    await useFlowEditor.getState().autoFillChannelIds();
    // 命中缓存，没有新请求。
    expect(stub.urls.length).toBe(1);
  });
});
