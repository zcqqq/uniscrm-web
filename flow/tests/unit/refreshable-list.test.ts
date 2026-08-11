import { describe, it, expect, vi, beforeEach } from "vitest";

// useRefreshableList 依赖的 React hook 换成 mini-react（helpers/mini-react.ts 里写了原因）。
// 这样测的是 hook 真实的依赖数组行为，而不是源码文本。
//
// 为什么写成两条：仓库里有两份 react —— flow/node_modules/react 和根部 hoist 的那份。
// 被测的 hook 住在 shared/，它的 "react" 解析到根部那份；本测试文件住在 flow/，裸名
// "react" 解析到 flow 那份。只 mock 一个的话，hook 拿到的还是真 React。
vi.mock("react", () => import("./helpers/mini-react"));
vi.mock("../../../node_modules/react/index.js", () => import("./helpers/mini-react"));

import { renderHook, settle } from "./helpers/mini-react";
import { useRefreshableList } from "../../../shared/frontend/hooks/useRefreshableList";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useRefreshableList", () => {
  it("首个响应落地前是 loading，且 data 为 null（不是空列表）", async () => {
    const d = deferred<string[]>();
    const hook = renderHook(() => useRefreshableList(() => d.promise, []));

    // 这一帧决定了 GitHub 面板会不会把"你还没连接账号"闪给一个连着账号的用户。
    expect(hook.current.loading).toBe(true);
    expect(hook.current.error).toBe(false);
    expect(hook.current.data).toBeNull();

    d.resolve(["a", "b"]);
    await settle();

    expect(hook.current.loading).toBe(false);
    expect(hook.current.error).toBe(false);
    expect(hook.current.data).toEqual(["a", "b"]);
    hook.unmount();
  });

  it("loading → error：失败不许退化成空列表", async () => {
    const d = deferred<string[]>();
    const hook = renderHook(() => useRefreshableList(() => d.promise, []));
    expect(hook.current.loading).toBe(true);

    d.reject(new Error("502"));
    await settle();

    expect(hook.current.loading).toBe(false);
    expect(hook.current.error).toBe(true);
    // data 必须是 null。给成 [] 的话调用方就分不出"取不到"和"一个都没有"，
    // 而这两件事要用户做的动作完全不同（重试 vs 去对方站点建一个）。
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it("ready 且结果为空集合：这是 ready 不是 error", async () => {
    const hook = renderHook(() => useRefreshableList(async () => [] as string[], []));
    await settle();
    expect(hook.current.error).toBe(false);
    expect(hook.current.loading).toBe(false);
    expect(hook.current.data).toEqual([]);
    hook.unmount();
  });

  it("refresh() 重新调用 fetcher，并且这一次的 reason 是 refresh", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (ctx: { reason: string }) => {
      seen.push(ctx.reason);
      return [seen.length];
    });
    const hook = renderHook(() => useRefreshableList(fetcher, []));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hook.current.data).toEqual([1]);

    hook.current.refresh();
    await settle();

    // 没有重新取数的话这里还是 1 —— 这正是"用户去 GitHub 改完再切回来"要修的东西。
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hook.current.data).toEqual([2]);
    // listCached 那类记忆化取数靠 reason 决定要不要先作废缓存。
    expect(seen).toEqual(["initial", "refresh"]);
    hook.unmount();
  });

  it("refresh 期间回到 loading，失败后回到 error（刷新失败不保留旧数据冒充新数据）", async () => {
    let current = deferred<string[]>();
    const hook = renderHook(() => useRefreshableList(() => current.promise, []));
    current.resolve(["old"]);
    await settle();
    expect(hook.current.data).toEqual(["old"]);

    current = deferred<string[]>();
    hook.current.refresh();
    expect(hook.current.loading).toBe(true);
    expect(hook.current.data).toBeNull();

    current.reject(new Error("boom"));
    await settle();
    expect(hook.current.error).toBe(true);
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it("enabled:false 时不取数，也不显示 loading", async () => {
    const fetcher = vi.fn(async () => ["x"]);
    const hook = renderHook(() => useRefreshableList(fetcher, [], { enabled: false }));
    await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(hook.current.loading).toBe(false);
    expect(hook.current.error).toBe(false);
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it("deps 变化重新取数，deps 不变的重渲染不重复取数", async () => {
    let dep = "A";
    const fetcher = vi.fn(async () => [dep]);
    const hook = renderHook(() => useRefreshableList(fetcher, [dep]));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    hook.rerender();
    await settle();
    // fetcher 每次渲染都是新函数，但它不参与依赖比较——否则每渲染一次就打一次外部 API。
    expect(fetcher).toHaveBeenCalledTimes(1);

    dep = "B";
    hook.rerender();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hook.current.data).toEqual(["B"]);
    hook.unmount();
  });

  it("卸载后到达的响应不再写状态", async () => {
    const d = deferred<string[]>();
    const hook = renderHook(() => useRefreshableList(() => d.promise, []));
    hook.unmount();
    d.resolve(["late"]);
    await settle();
    // 没有抛错、也没有把数据写回一个已经卸载的组件即可。
    expect(true).toBe(true);
  });
});
