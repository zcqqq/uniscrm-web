import { evaluateCondition } from "./engine";
import { USER_PROP_PREFIX } from "../../metadata/dataTypes";

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

// USER_PROP_PREFIX ("user.") 里的 "." 在正则里有特殊含义，动态拼正则时必须转义——
// 否则 "." 会当成通配符，理论上能误配非作者字段（如 "userxfollowers_count"）。
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 值侧表达式里的作者引用形如 "$user.followers_count"——与 engine.ts 的 PROP_REF_RE 同源，
// 但这里只关心"引用了没有"/"引用的是哪个 propId"，不需要求值。
const USER_VALUE_REF_RE = new RegExp(`\\$(${escapeRegExp(USER_PROP_PREFIX)}\\w+)`, "g");

// 这个节点的条件是否引用了作者字段——引用了才让 link 追加一次 channels.list（1 unit）。
// YOUTUBE_API_KEY 是全平台共享的 10000 units/天免费配额，而 condition 节点的调用量随
// flow 数量线性增长，绝大多数条件只看 view_count/like_count，白打就是白烧。
// 两种引用形式都要覆盖：字段侧 cond.field 直接是限定名；值侧写在表达式里
// （like_count > $user.followers_count * 0.01 —— 字段侧完全是内容字段）。
export function conditionsNeedAuthor(
  conditions: { field: string; operator: string; value: string }[]
): boolean {
  return (conditions || []).some(
    (c) =>
      c.field?.startsWith(USER_PROP_PREFIX) ||
      new RegExp(USER_VALUE_REF_RE.source).test(String(c.value ?? ""))
  );
}

// videoId 取自 payload.source_content_id，与 youtubeActionRequest 一致（index.ts）。
// contentId/flowId 只用于 link 侧日志关联，link 不拿它们做任何判定。
export function youtubeConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
  // 由 conditionsNeedAuthor 算出来。link 侧据此决定要不要追加 channels.list。
  withAuthor: boolean;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload, withAuthor } = args;
  return {
    url: `${env.LINK_URL}/internal/youtube/video-stats`,
    body: JSON.stringify({
      videoId: String(payload?.source_content_id ?? ""),
      contentId,
      flowId: flowId ?? null,
      withAuthor,
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

  // "绝不猜"要落到字段粒度，不只是响应粒度：resolveProps 对 API 没返回的 source path
  // 直接不写 key（duration 解析失败时同样不写），浅合并就会把 trigger 时的旧值补回来，
  // evaluateCondition 分辨不出来。例：作者后来隐藏了点赞数，videos.list 不再返回
  // statistics.likeCount，旧的 like_count: "800" 被还原，like_count > 500 于是走了 true
  // ——判的是一个已经不存在的数。这种情况一律 failed，并把哪个字段没取到写进 failureReason。
  // 两边都没有的字段是另一回事（条件写在了 API 从来不返回的字段上），evaluateCondition
  // 本就按缺失处理，不升级成 failed。
  // withAuthor 为 true 时 resp.props 是 videos.list 与 channels.list 合并后的**同一份**
  // 新鲜数据（link 侧合的），所以 user.* 字段同样受这个守卫保护——例：频道打开了
  // hiddenSubscriberCount，channels.list 不再返回 statistics.subscriberCount，旧的
  // user.followers_count 被还原，比例条件就会拿一个已经不存在的分母去判定。
  // 作者引用不止字段侧一种形式：like_count > $user.followers_count * 0.01 里字段侧完全
  // 是内容字段，作者字段只出现在值表达式里——所以除了 c.field 本身，还要把值里的
  // $user.x 引用一并纳入检查。
  const props = resp.props;
  for (const c of conditions || []) {
    if (!c.field) continue;
    const refs = new Set<string>([c.field]);
    for (const m of String(c.value ?? "").matchAll(new RegExp(USER_VALUE_REF_RE.source, "g"))) {
      refs.add(m[1]);
    }
    for (const ref of refs) {
      if (!(ref in props) && ref in payload) {
        return {
          branch: "failed",
          payload,
          failureReason: `stat_unavailable: ${ref} not returned by YouTube`,
        };
      }
    }
  }

  // field 为空的半成品条目跳过——与 executeFlow 里 trigger 的 allPass 写法逐字一致。
  const allPass = (conditions || []).every(
    (c) => !c.field || evaluateCondition(c.field, c.operator, String(c.value), merged)
  );
  return { branch: allPass ? "true" : "false", payload: merged };
}
