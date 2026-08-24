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
    if (!(c.field in props) && c.field in payload) {
      return {
        branch: "failed",
        payload,
        failureReason: `stat_unavailable: ${c.field} not returned by GitHub`,
      };
    }
  }

  return { branch: conditionsPass(conditions, logic, merged) ? "true" : "false", payload: merged };
}
