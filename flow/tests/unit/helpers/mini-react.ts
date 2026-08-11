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

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

function renderOnce() {
  cursor = 0;
  queued = [];
  result = renderFn!();
  const effects = queued;
  queued = [];
  for (const run of effects) run();
}

function flushRender() {
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
      if (++guard > 50) throw new Error("mini-react: render loop did not settle in 50 passes");
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
  /** 外部原因（如 props 变化）导致的重渲染。 */
  rerender: () => void;
  unmount: () => void;
}

/** 挂载一个 hook 并保持可读。同一时刻只支持一个（全局 slot 数组），每次调用会重置。 */
export function renderHook<T>(fn: () => T): HookHandle<T> {
  slots = [];
  cursor = 0;
  renderFn = fn as () => unknown;
  flushRender();
  return {
    get current() {
      return result as T;
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
