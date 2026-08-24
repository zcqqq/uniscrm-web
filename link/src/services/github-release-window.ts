import type { GitHubRelease } from "./github-api";
import { resolveProps } from "./pollers/resolve-props";
import { ContentMetadata_GitHub } from "../../../metadata/github";

const GITHUB_METADATA = ContentMetadata_GitHub.find((m) => m.sourceContentType === "watch:get-releases")!;

// 单条正文上限——比 release_history 的 2000 更宽松没有必要：这里同样要给下面的累计字节
// 预算和 HTTP 响应体大小留余量，道理和 github-releases.ts 的 MAX_HISTORY_ENTRY_TEXT 一样，
// 只是这是一次同步请求/响应，不是 Queues 消息，独立定数字。
const MAX_ENTRY_TEXT = 2_000;

// 累计 UTF-8 字节预算（中文最坏 3 倍/字符）。maxWaitDays 天内正常只有个位数 release，
// 这个预算几乎用不到；真遇到病态高频发版，超预算的条目整条不进窗口——与
// release_history 的"退回不带文本的形状"不同：这个窗口只有一个用途（拼进
// release_notes_window），没有文本就没有存在的意义，不像 release_history 里空文本
// 条目还要继续贡献计数。
const TEXT_BUDGET_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export interface ReleaseWindowEntry {
  published_at: string;
  title: string;
  content_text: string;
}

export function buildReleaseWindow(
  releases: GitHubRelease[],
  maxWaitDays: number,
  includePrerelease: boolean,
  now: number
): ReleaseWindowEntry[] {
  const windowMs = maxWaitDays * 24 * 60 * 60 * 1000;
  let textBudget = TEXT_BUDGET_BYTES;
  const out: ReleaseWindowEntry[] = [];

  for (const r of releases) {
    if (r.draft || r.published_at === null) continue;
    if (!includePrerelease && r.prerelease === true) continue;
    if (now - Date.parse(r.published_at as string) > windowMs) continue;

    const resolved = resolveProps(r as unknown as Record<string, unknown>, GITHUB_METADATA.contentProps);
    const title = String(resolved.title || r.tag_name || "").slice(0, MAX_ENTRY_TEXT);
    const contentText = String(resolved.content_text || "").slice(0, MAX_ENTRY_TEXT);
    const cost = textEncoder.encode(title + contentText).length;
    if (cost > textBudget) continue;
    textBudget -= cost;

    out.push({ published_at: r.published_at as string, title, content_text: contentText });
  }

  return out;
}

// 单一个 maxWaitDays 同时做两件事：往回看多久算"是否最新"，以及强制发帖的上限。
// 见 spec「Why one window number, not two」——分开两个数字会让 notes 悄悄漏内容。
export function isLatestRelease(
  window: { published_at: string }[],
  publishedAt: string,
  maxWaitDays: number,
  now: number
): boolean {
  const capMs = maxWaitDays * 24 * 60 * 60 * 1000;
  if (now - Date.parse(publishedAt) > capMs) return true;
  const maxPublishedAt = window.reduce((max, r) => Math.max(max, Date.parse(r.published_at)), -Infinity);
  return Date.parse(publishedAt) >= maxPublishedAt;
}
