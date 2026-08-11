import { describe, it, expect, vi, beforeEach } from "vitest";

// api.ts 只经 authFetch 出网，把它换掉就能数出真正发了几次请求。
const stub = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../../shared/frontend/lib/auth-fetch", () => ({
  authFetch: async (url: string) => {
    stub.urls.push(url);
    return new Response(JSON.stringify([{ id: `c${stub.urls.length}`, username: "acct" }]), {
      status: 200,
      // i18n-ok: HTTP header name/value, not user-facing text
      headers: { "Content-Type": "application/json" },
    });
  },
}));

import { api } from "../../frontend/lib/api";
import flowEditorSource from "../../frontend/store/flow-editor.ts?raw";

describe("channels.listCached 的记忆化与显式作废", () => {
  beforeEach(() => {
    stub.urls.length = 0;
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
});

describe("autoFillChannelIds 不参与作废", () => {
  it("flow-editor 的自动填充仍走记忆化，不调用 invalidateListCache", () => {
    // 它是加载 flow 时的后台便利逻辑，没有任何用户可见的"刷新"入口；在那里作废缓存
    // 只会把这份缓存本来要挡的并发重复请求放回来。用户点了别处的刷新按钮之后，
    // 它下一次调用自然就拿到新数据了。
    expect(flowEditorSource).toContain("api.channels.listCached");
    expect(flowEditorSource).not.toContain("invalidateListCache");
  });
});
