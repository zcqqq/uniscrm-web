import { useCallback, useEffect, useRef, useState } from "react";

// 「打开选择器 → 发现要选的东西不在 → 去 github.com / youtube.com / x.com 上把它建出来
// → 切回这个从没卸载过的标签页 → 列表还是老的」——这条路径对每一个「数据在别人家、
// 我们只是拉一份快照」的选择器都成立。
//
// 为什么做成共享 hook 而不是在 GitHub 面板里就地修一次：下一个写渠道节点的人不会记得
// 这件事。把「取数 + loading/error 三态 + 显式 refresh」收进一个 hook，新面板照抄一行
// useRefreshableList 就自带刷新能力，忘不掉。
//
// 三态必须保持互相独立，不许压平（GitHub 面板的注释解释过代价）：
//   loading —— 首个响应落地之前。绝不能提前显示「你还没连接账号」，listWatchedRepos
//              最多要顺序翻 10 页 GitHub，这几秒会把一个连着账号的用户赶去重新连接。
//   error   —— 取数失败。绝不能退化成空列表：空列表的用户动作是「去 GitHub Watch 一个
//              仓库」，失败的用户动作是「重试」，指错了用户就白跑一趟。
//   ready   —— 拿到了数据，data 可能是空集合，那是真的空。

export type RefreshableListStatus = "loading" | "ready" | "error";

/** 取数原因。listCached 这类带记忆化的取数据此判断要不要先把缓存作废。 */
export interface RefreshableListFetchContext {
  reason: "initial" | "refresh";
}

export type RefreshableListFetcher<T> = (ctx: RefreshableListFetchContext) => Promise<T>;

export interface RefreshableList<T> {
  /** ready 之前恒为 null。失败时也是 null——失败不冒充空数据。 */
  data: T | null;
  loading: boolean;
  error: boolean;
  /** 用户显式刷新：重新跑一次 fetcher，reason 为 "refresh"。 */
  refresh: () => void;
}

export interface RefreshableListOptions {
  /**
   * false 表示此刻不该取数（例如尚未选择事件/账号，或当前操作根本不需要这个列表）。
   * 此时状态是 ready + data:null，不是 loading——没有在途请求就不该转圈。
   */
  enabled?: boolean;
}

/**
 * @param fetcher 取数函数。每次渲染可以是新函数，不参与依赖比较（内部用 ref 取最新的）。
 * @param deps    需要重新取数的外部依赖（如 channelType、channelId）。长度必须在组件生命
 *                周期内保持恒定——和 React 自己的依赖数组同一条约束。
 */
export function useRefreshableList<T>(
  fetcher: RefreshableListFetcher<T>,
  deps: unknown[] = [],
  options?: RefreshableListOptions
): RefreshableList<T> {
  const enabled = options?.enabled !== false;

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // 首个响应落地前必须是 loading。初值就得是 loading，不能等 effect 跑起来才改——
  // 中间那一帧会把「未连接」文案闪给用户看。
  const [state, setState] = useState<{ status: RefreshableListStatus; data: T | null }>({
    status: enabled ? "loading" : "ready",
    data: null,
  });

  const [nonce, setNonce] = useState(0);
  // refresh 触发的那一次取数才是 "refresh"；deps 变化引起的重新取数属于首次加载。
  const reasonRef = useRef<"initial" | "refresh">("initial");

  const refresh = useCallback(() => {
    reasonRef.current = "refresh";
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "ready", data: null });
      return;
    }
    const reason = reasonRef.current;
    reasonRef.current = "initial";
    let cancelled = false;
    setState({ status: "loading", data: null });
    fetcherRef
      .current({ reason })
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch(() => {
        // 失败不写 data：空列表和取不到是两件事，压平了用户会照着错误的提示去做无用功。
        if (!cancelled) setState({ status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  return {
    data: state.data,
    loading: state.status === "loading",
    error: state.status === "error",
    refresh,
  };
}
