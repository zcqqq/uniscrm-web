// 一个只够跑 hook 的 React 替身。
//
// 为什么要自己写：本模块的测试跑在 @cloudflare/vitest-pool-workers（workerd）里，没有
// document，react-dom 挂不上去；@testing-library/react 和 react-test-renderer 本仓库都
// 没装，为了一个 hook 去装测试依赖不划算（CI 的 audits job 也没有依赖安装）。
// 但只断言源码文本（?raw）挡不住 useRefreshableList 真正要挡的东西——「refresh 之后
// effect 会不会真的再跑一遍 fetcher」是依赖数组的行为，不是文本。
//
// 于是用 vi.mock("react", () => import("./helpers/mini-react")) 把 hook 依赖的那 5 个
// React API 换成这里的实现：一个 slot 数组 + 一个同步的 render 循环 + effect 依赖比较。
// 语义刻意与 React 对齐的部分：slot 按调用顺序编号、deps 用 Object.is 逐项比较、
// deps 变化时先跑上一次的 cleanup 再跑新 effect、setState 相同值不触发重渲染。
// 刻意不实现的部分：并发、批处理、Suspense、组件树——hook 测试都用不到。

type Slot =
  | { kind: "state"; value: unknown }
  | { kind: "ref"; ref: { current: unknown } }
  | { kind: "memo"; deps: unknown[] | undefined; value: unknown }
  | { kind: "effect"; deps: unknown[] | undefined; cleanup: (() => void) | void };

let slots: Slot[] = [];
let cursor = 0;
let renderFn: (() => unknown) | null = null;
let result: unknown = null;
let queued: Array<() => void> = [];
let rendering = false;
let dirty = false;
// 每一趟渲染在「effect 还没跑」的那一刻的返回值。用来断言 useState 的初值本身
// （React 里就是首帧渲染出去的东西），而不只是 effect 跑完之后的状态。
let snapshots: unknown[] = [];
// 卸载之后还发生的 setState 次数。React 里这会是一次泄漏（或 act 警告），这里记下来
// 让测试可以直接断言"没有"，而不是靠"没抛错"这种什么都证明不了的说法。
let writesAfterUnmount = 0;
// 渲染失控（effect 依赖写错就会这样：取数 → setState → 重渲染 → 再取数）时熔断。
// 刻意不抛异常：抛出来的那个错会顺着 promise 回调变成 unhandled rejection，被
// vitest 的 --dangerouslyIgnoreUnhandledErrors 吞掉，然后剩下的在途 promise 继续
// 制造新一轮渲染，最后是 worker 被拖死、报一句看不懂的 "Worker exited unexpectedly"。
// 熔断之后一切渲染变成空操作，测试里那条计数断言就能干干净净地红。
const MAX_RENDERS = 500;
let runaway = false;

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

function renderOnce() {
  cursor = 0;
  queued = [];
  result = renderFn!();
  snapshots.push(result);
  const effects = queued;
  queued = [];
  for (const run of effects) run();
}

function flushRender() {
  if (renderFn === null) {
    // 已卸载。真 React 在这里是警告 + 丢弃，这里记一笔并安静返回——如果任由它去调
    // renderFn 会在 promise 回调里抛错，而抛出来的错正好被 vitest 的
    // --dangerouslyIgnoreUnhandledErrors 吞掉，测试反而看不见。
    writesAfterUnmount++;
    return;
  }
  if (runaway) return;
  if (rendering) {
    dirty = true;
    return;
  }
  rendering = true;
  try {
    let guard = 0;
    do {
      dirty = false;
      renderOnce();
      if (++guard > 50 || snapshots.length > MAX_RENDERS) {
        runaway = true;
        break;
      }
    } while (dirty);
  } finally {
    rendering = false;
  }
}

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
  const i = cursor++;
  if (!slots[i]) {
    slots[i] = { kind: "state", value: typeof initial === "function" ? (initial as () => S)() : initial };
  }
  const slot = slots[i] as { kind: "state"; value: S };
  const set = (next: S | ((prev: S) => S)) => {
    const value = typeof next === "function" ? (next as (prev: S) => S)(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    flushRender();
  };
  return [slot.value, set];
}

export function useRef<T>(initial: T): { current: T } {
  const i = cursor++;
  if (!slots[i]) slots[i] = { kind: "ref", ref: { current: initial } };
  return (slots[i] as { kind: "ref"; ref: { current: T } }).ref;
}

export function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const i = cursor++;
  const slot = slots[i] as { kind: "memo"; deps: unknown[] | undefined; value: T } | undefined;
  if (!slot || !depsEqual(slot.deps, deps)) {
    slots[i] = { kind: "memo", deps, value: factory() };
  }
  return (slots[i] as { kind: "memo"; value: T }).value;
}

export function useCallback<T>(fn: T, deps?: unknown[]): T {
  return useMemo(() => fn, deps);
}

export function useEffect(fn: () => (() => void) | void, deps?: unknown[]): void {
  const i = cursor++;
  const slot = slots[i] as { kind: "effect"; deps: unknown[] | undefined; cleanup: (() => void) | void } | undefined;
  if (!slot) {
    const created: Slot = { kind: "effect", deps, cleanup: undefined };
    slots[i] = created;
    queued.push(() => {
      (created as { cleanup: (() => void) | void }).cleanup = fn();
    });
    return;
  }
  if (!depsEqual(slot.deps, deps)) {
    slot.deps = deps;
    queued.push(() => {
      slot.cleanup?.();
      slot.cleanup = fn();
    });
  }
}

export interface HookHandle<T> {
  readonly current: T;
  /** 每一趟渲染在 effect 跑之前的返回值，[0] 就是首帧。 */
  readonly snapshots: readonly T[];
  /** 渲染趟数。用来断言"没有重新取数"之类的事没有偷偷多渲染一轮。 */
  readonly renders: number;
  /** 卸载之后仍然发生的 setState 次数，应恒为 0。 */
  readonly writesAfterUnmount: number;
  /** 渲染是否失控到被熔断。为 true 说明 effect 的依赖数组写错了。 */
  readonly runaway: boolean;
  /** 外部原因（如 props 变化）导致的重渲染。 */
  rerender: () => void;
  unmount: () => void;
}

/** 挂载一个 hook 并保持可读。同一时刻只支持一个（全局 slot 数组），每次调用会重置。 */
export function renderHook<T>(fn: () => T): HookHandle<T> {
  slots = [];
  cursor = 0;
  snapshots = [];
  writesAfterUnmount = 0;
  runaway = false;
  renderFn = fn as () => unknown;
  flushRender();
  return {
    get current() {
      return result as T;
    },
    get snapshots() {
      return snapshots as readonly T[];
    },
    get renders() {
      return snapshots.length;
    },
    get writesAfterUnmount() {
      return writesAfterUnmount;
    },
    get runaway() {
      return runaway;
    },
    rerender: flushRender,
    unmount() {
      for (const slot of slots) if (slot.kind === "effect") slot.cleanup?.();
      slots = [];
      renderFn = null;
    },
  };
}

/** 让已 resolve/reject 的 promise 回调跑完（外加 setState 引发的同步重渲染）。 */
export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
