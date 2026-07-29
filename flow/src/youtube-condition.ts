import { evaluateCondition } from "./engine";

export interface VideoStatsResponse {
  ok: boolean;
  props?: Record<string, unknown>;
  reason?: string;
}

export interface YouTubeConditionOutcome {
  branch: "true" | "false" | "failed";
  payload: Record<string, unknown>;
  failureReason?: string;
}

// videoId 取自 payload.source_content_id，与 youtubeActionRequest 一致（index.ts）。
// contentId/flowId 只用于 link 侧日志关联，link 不拿它们做任何判定。
export function youtubeConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload } = args;
  return {
    url: `${env.LINK_URL}/internal/youtube/video-stats`,
    body: JSON.stringify({
      videoId: String(payload?.source_content_id ?? ""),
      contentId,
      flowId: flowId ?? null,
    }),
  };
}

// 判定用刚取回的新鲜值，不用 trigger 时的快照——否则这个节点的结果与 trigger 当场判定
// 逐字相同，毫无意义。合并后的 payload 也交给下游：用户显式放了一个"重新检查"节点，
// 之后引用 $content.view_count 还拿到一天前的旧数字才是反直觉的。
// 取不到数据一律 "failed"，绝不猜 true/false——"没涨到 1000 赞"和"视频没了"是两回事。
export function resolveYouTubeCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: VideoStatsResponse
): YouTubeConditionOutcome {
  if (!resp.ok || !resp.props) {
    return {
      branch: "failed",
      payload,
      failureReason: resp.reason || "youtube_api_error: no reason reported",
    };
  }

  const merged = { ...payload, ...resp.props };
  // field 为空的半成品条目跳过——与 executeFlow 里 trigger 的 allPass 写法逐字一致。
  const allPass = (conditions || []).every(
    (c) => !c.field || evaluateCondition(c.field, c.operator, String(c.value), merged)
  );
  return { branch: allPass ? "true" : "false", payload: merged };
}
