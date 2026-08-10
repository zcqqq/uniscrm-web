// GitHub REST v3 封装。只做 HTTP 与错误分类，不碰 D1、不碰 metadata。
//
// 实测事实（2026-08-10，未认证下测得，见设计文档「实测事实」一节）：
//   - 304 响应**计入** rate limit（x-ratelimit-used 照样 +1）。所以 If-None-Match 只省
//     带宽和 JSON 解析，不省配额 —— 预算必须按「每 repo 每轮 1 次调用」算。
//   - ETag 是弱验证器且可能在两次请求间变化（不同边缘节点），304 是优化不是保证，
//     代码不能依赖它成立。
//   - /releases 的响应里**没有任何 repository 信息**（没有 stargazers_count），
//     作者字段必须另打 getRepo。
const API = "https://api.github.com";

/** 401：token 失效/被撤销。上游据此把 channel 标记为需重连，并停掉该租户本轮。 */
export class GitHubUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnauthorizedError";
  }
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
}

export interface WatchedRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
}

function headers(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "uniscrm-link",
    ...extra,
  };
}

/** 403 + 余额为 0，或 429 —— 两种都表示「这轮别再打了」。403 但余额非 0 是无权访问，不是限流。 */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

/** 当前 token 身份 Watch 的全部 repo。私有 repo 只在 token 带 repo scope 时出现。 */
export async function listWatchedRepos(token: string): Promise<WatchedRepo[]> {
  const out: WatchedRepo[] = [];
  // 上限 10 页（1000 个 repo）—— 纯粹是失控保护，不是产品限制；真有人 Watch 超过
  // 1000 个 repo，下拉框本身也已经不可用了。
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${API}/user/subscriptions?per_page=100&page=${page}`, { headers: headers(token) });
    if (res.status === 401) throw new GitHubUnauthorizedError(await res.text());
    if (!res.ok) throw new Error(`listWatchedRepos failed ${res.status}: ${await res.text()}`);
    const batch = (await res.json()) as WatchedRepo[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function listReleases(
  token: string,
  fullName: string,
  etag: string | null
): Promise<{ releases: GitHubRelease[] | null; etag: string | null; rateLimited: boolean; notFound: boolean }> {
  const res = await fetch(`${API}/repos/${fullName}/releases?per_page=100`, {
    headers: headers(token, etag ? { "If-None-Match": etag } : undefined),
  });

  if (res.status === 401) throw new GitHubUnauthorizedError(await res.text());
  if (res.status === 304) return { releases: null, etag, rateLimited: false, notFound: false };
  if (isRateLimited(res)) return { releases: null, etag, rateLimited: true, notFound: false };
  // 404（删除/转私有）与「403 但配额充足」（无权访问）都是「这个 repo 现在读不到」，
  // 归一成 notFound：跳过它，不影响同轮其它 repo。
  if (res.status === 404 || res.status === 403) return { releases: null, etag, rateLimited: false, notFound: true };
  if (!res.ok) throw new Error(`listReleases(${fullName}) failed ${res.status}: ${await res.text()}`);

  return {
    releases: (await res.json()) as GitHubRelease[],
    etag: res.headers.get("ETag"),
    rateLimited: false,
    notFound: false,
  };
}

/** repo 详情（作者字段的来源）。读不到返 null —— 没有作者字段照样发内容事件。 */
export async function getRepo(token: string, fullName: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${API}/repos/${fullName}`, { headers: headers(token) });
  if (res.status === 401) throw new GitHubUnauthorizedError(await res.text());
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}
