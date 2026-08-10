// 发版计数。口径跟随触发节点的 includePrerelease，所以只能在 flow 侧算 —— link 的轮询器
// 按 repo 走，同一个 repo 可能被两个勾选框状态不同的 flow 盯着，它没资格替它们决定。
// link 只负责下发原始的 release_history（近 30 天的 {published_at, prerelease}）。

export interface ReleaseHistoryEntry {
  published_at: string;
  prerelease: boolean;
}

const WINDOWS: [keyof ReleaseCounts, number][] = [
  ["release_count_1d", 1],
  ["release_count_7d", 7],
  ["release_count_30d", 30],
];

export interface ReleaseCounts {
  release_count_1d: number;
  release_count_7d: number;
  release_count_30d: number;
}

/**
 * payload 可能被序列化进 content_flow_pending 再取回，也可能来自 AI 生成的畸形图，
 * 所以每一层都做类型检查：畸形条目丢掉，绝不抛 —— 抛出去会让整条队列消息重试，
 * 这一批里已经执行过的 action 全部重跑（重复发帖/私信）。
 */
export function parseReleaseHistory(raw: unknown): ReleaseHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseHistoryEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const publishedAt = (e as { published_at?: unknown }).published_at;
    if (typeof publishedAt !== "string") continue;
    if (Number.isNaN(Date.parse(publishedAt))) continue;
    out.push({ published_at: publishedAt, prerelease: (e as { prerelease?: unknown }).prerelease === true });
  }
  return out;
}

export function computeReleaseCounts(
  history: ReleaseHistoryEntry[],
  includePrerelease: boolean,
  now: number
): ReleaseCounts {
  const eligible = includePrerelease ? history : history.filter((e) => !e.prerelease);
  const counts = { release_count_1d: 0, release_count_7d: 0, release_count_30d: 0 } as ReleaseCounts;
  for (const [key, days] of WINDOWS) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    // 闭区间：正好落在窗口边界上的算在窗口内。
    counts[key] = eligible.filter((e) => Date.parse(e.published_at) >= cutoff).length;
  }
  return counts;
}
