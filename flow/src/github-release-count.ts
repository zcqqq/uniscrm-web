// 发版计数。口径跟随触发节点的 includePrerelease，所以只能在 flow 侧算 —— link 的轮询器
// 按 repo 走，同一个 repo 可能被两个勾选框状态不同的 flow 盯着，它没资格替它们决定。
// link 只负责下发原始的 release_history（近 30 天的 {published_at, prerelease}）。

export interface ReleaseHistoryEntry {
  published_at: string;
  prerelease: boolean;
  title?: string;
  content_text?: string;
}

export interface ReleaseNote {
  title: string;
  content_text: string;
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
    const entry: ReleaseHistoryEntry = { published_at: publishedAt, prerelease: (e as { prerelease?: unknown }).prerelease === true };
    // title/content_text 是后加的可选字段——旧的存量 payload（写进 content_flow_pending
    // 再取回的那种）不会有它们，畸形类型也只丢这两个字段，不连坐整条历史。
    const title = (e as { title?: unknown }).title;
    if (typeof title === "string") entry.title = title;
    const contentText = (e as { content_text?: unknown }).content_text;
    if (typeof contentText === "string") entry.content_text = contentText;
    out.push(entry);
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

// 只服务 1 天聚合这一个场景——不像 computeReleaseCounts 那样对 1d/7d/30d 都算：目前只有
// 1 天窗口有下游消费者（同一天内多条 release 合并总结），7d/30d 的计数已经够用，不为它们
// 多算一份可能很大的文本数组。title/content_text 分开存在数组元素里（不拼成一段文本）——
// 具体怎么呈现、怎么按 hosting/sponsoring 这类分类总结，留给下游 skill 的 prompt 决定，
// 这里只出结构化数据。
export function computeReleaseNotes1d(
  history: ReleaseHistoryEntry[],
  includePrerelease: boolean,
  now: number
): ReleaseNote[] {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const eligible = includePrerelease ? history : history.filter((e) => !e.prerelease);
  const notes: ReleaseNote[] = [];
  for (const e of eligible) {
    if (Date.parse(e.published_at) < cutoff) continue;
    // link 侧只给 48h 内的条目带文本（TEXT_WINDOW_MS，见 github-releases.ts）并有字节预算——
    // 超出的条目会落在 1d 窗口内却没有 title/content_text，静默跳过而不是拼出半条数据。
    if (typeof e.title !== "string" || typeof e.content_text !== "string") continue;
    notes.push({ title: e.title, content_text: e.content_text });
  }
  return notes;
}
