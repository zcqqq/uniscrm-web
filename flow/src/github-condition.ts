import { conditionsPass } from "./engine";

export interface GithubReleaseCheckResponse {
  ok: boolean;
  props?: Record<string, unknown>;
  reason?: string;
}

export interface GithubConditionOutcome {
  branch: "true" | "false" | "failed";
  payload: Record<string, unknown>;
  failureReason?: string;
}

export function githubConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
  maxWaitDays: number;
  includePrerelease: boolean;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload, maxWaitDays, includePrerelease } = args;
  return {
    url: `${env.LINK_URL}/internal/github/release-recheck`,
    body: JSON.stringify({
      channelId: String(payload?.channel_id ?? ""),
      repoFullName: String(payload?.repo_full_name ?? ""),
      includePrerelease,
      maxWaitDays,
      sourceContentId: String(payload?.source_content_id ?? ""),
      publishedAt: String(payload?.source_created_at ?? ""),
      contentId,
      flowId: flowId ?? null,
    }),
  };
}

// 只有这三个字段是本节点复查后真正会刷新的——别的字段（title、tag_name、is_prerelease、
// user.* 等）压根不在 link 返回的 props 里，那是设计如此，不是数据丢失：它们是触发时刻
// 就已经确定的不可变属性，用触发快照判定完全正确。守卫只盯这三个"应该新鲜却没新鲜"的
// 字段，其它字段被"stat_unavailable"误伤过——19/22 个可选条件字段之前会被这条守卫
// 无差别拦成 failed。
const FRESH_GITHUB_PROPS = new Set(["is_latest_release", "release_count_window", "release_notes_window"]);

// 与 resolveYouTubeCondition（youtube-condition.ts）同一套"绝不猜"守卫：条件引用的字段在
// 新鲜数据里没有、旧 payload 里却有，就升级成 failed——不能悄悄拿旧值去判一个已经不存在
// 的数。githubCondition 没有作者字段这个概念，所以这里比 youtube 版本少一层 $user.x
// 值侧引用扫描。
export function resolveGithubCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: GithubReleaseCheckResponse,
  logic?: unknown
): GithubConditionOutcome {
  if (!resp.ok || !resp.props) {
    return {
      branch: "failed",
      payload,
      failureReason: resp.reason || "github_api_error: no reason reported",
    };
  }

  const merged = { ...payload, ...resp.props };
  const props = resp.props;

  for (const c of conditions || []) {
    if (!c || typeof c !== "object") continue;
    if (!c.field) continue;
    if (FRESH_GITHUB_PROPS.has(c.field) && !(c.field in props) && c.field in payload) {
      return {
        branch: "failed",
        payload,
        failureReason: `stat_unavailable: ${c.field} not returned by GitHub`,
      };
    }
  }

  return { branch: conditionsPass(conditions, logic, merged) ? "true" : "false", payload: merged };
}
