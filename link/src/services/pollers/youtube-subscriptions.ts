import type { Env, Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { EntityStateStore } from "../entity-state";
import { UsersService } from "../users";
import { resolveProps } from "./resolve-props";
import { recordYouTubeQuota } from "../youtube-quota";
import {
  fetchSubscribedChannelIds,
  fetchChannelDetails,
  CHANNELS_BATCH_SIZE,
  type YouTubeChannelItem,
} from "../youtube-subscriptions-api";
import { UserMetadata_YouTube } from "../../../../metadata/youtube";

const YT_USER_META = UserMetadata_YouTube.find((m) => m.sourceUserType === "own:get-subscriptions")!;

// 被订阅的频道写成 user 行时的 channel_type。账号行本身是 YOUTUBE_ACCOUNT ——
// 两者不是一回事，写混了会让 Users 列表把账号自己也算成一个被关注的人。
const SUBSCRIBED_CHANNEL_TYPE = "YOUTUBE";

export interface YouTubeSubscriptionsPollerContext {
  env: Env;
  accountChannelId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  entityState: EntityStateStore;
  tenantId: number;
  pipelineUser?: Pipeline;
  deadline: number;
}

// D1 的 INT 列：API 返回的是字符串（"19500000"）。空串/非数字一律返回 undefined，
// 让调用方跳过该列而不是写 0 —— 不知道 ≠ 是零。
function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export async function runYouTubeSubscriptionsPoller(ctx: YouTubeSubscriptionsPollerContext): Promise<void> {
  // 自播种。X 的 poller 语义是「没有 state 行 = 未授权」，YouTube 不同：授权凭证
  // 就在 channels 行的 config 里，这张表在这里只承担节流时间戳的职责。自播种消掉
  // 了播种时序这一整类 bug，也不需要给存量频道补行的运维脚本。
  await ctx.linkDb
    .prepare("INSERT OR IGNORE INTO channel_poll_state (channel_id, poller_name) VALUES (?, 'subscriptions')")
    .bind(ctx.accountChannelId)
    .run();

  const walk = await fetchSubscribedChannelIds(ctx.accessToken, ctx.deadline);
  // completeWalk 是本文件存在的全部理由：只有它为 true 才允许把「本轮结果里没有这个
  // 频道」读成「取消订阅了」。subscriptions.list 分页中途失败、命中 deadline、或任何一批
  // channels.list 抛出，都必须把它按到 false，并且一旦按下就不再翻回 true。
  let completeWalk = walk.complete;
  // 本轮实际发出的 YouTube Data API 请求数：subscriptions.list 的每一页 + 每一批
  // channels.list（无论成功失败，请求都已经发出、配额已经计费）。
  let apiCalls = walk.calls;

  console.log(JSON.stringify({
    event: "youtube_subscriptions_poll_started",
    account_channel_id: ctx.accountChannelId,
    subscribed: walk.ids.length,
    completeWalk,
  }));

  const usersService = new UsersService(ctx.tenantDb, {
    pipelineUser: ctx.pipelineUser,
    tenantId: ctx.tenantId,
    entityState: ctx.entityState,
  });

  // 诊断用：本轮实际写成功的频道数（用于结束时的日志），**不**参与取消订阅的判定 ——
  // 见下方 completeWalk 分支的注释（Critical fix：diff 必须以 walk.ids 为准，channels.list
  // 实际返回了哪些行与「用户是否还订阅」无关）。
  let refreshed = 0;

  try {
    for (let i = 0; i < walk.ids.length; i += CHANNELS_BATCH_SIZE) {
      if (Date.now() >= ctx.deadline) {
        // 还有批次没跑完 —— 本轮的「订阅列表」是残缺的，不能拿来判定取消订阅。
        completeWalk = false;
        console.log(JSON.stringify({
          event: "youtube_subscriptions_poll_deadline",
          account_channel_id: ctx.accountChannelId, processed: refreshed,
        }));
        break;
      }

      const batch = walk.ids.slice(i, i + CHANNELS_BATCH_SIZE);
      apiCalls++;
      let items: YouTubeChannelItem[];
      try {
        items = await fetchChannelDetails(ctx.accessToken, batch);
      } catch (e) {
        // 这一批频道本轮没拿到 snippet/statistics —— 但注意：不拿到详情 ≠ 取消订阅
        // （被删除/终止/地区屏蔽的频道也会让 channels.list 对它缄默或整批失败）。
        // channels.list 结果从来就不是订阅判定的依据，只是资料来源；completeWalk=false
        // 单纯是为了如实反映「本轮没能把这批频道的资料刷新完」，与 diff 的正确性无关
        // （diff 已经只看 walk.ids，见下方）。
        completeWalk = false;
        console.error(JSON.stringify({
          event: "youtube_channels_batch_error",
          account_channel_id: ctx.accountChannelId, batchStart: i, error: String(e),
        }));
        continue;
      }

      for (const item of items) {
        // 全量 payload 进日志不进库（CLAUDE.md）。
        console.log(JSON.stringify({ event: "youtube_channel_raw", channel_id: item.id, payload: item }));

        const props = resolveProps(item as unknown as Record<string, unknown>, YT_USER_META.userProps, YT_USER_META.linkPrefix);
        // subscriberCount/videoCount 到这里还是 API 原样的字符串；D1 列是 INT，非数字/缺席
        // 必须让该 key 从 props 里彻底消失（而不是变成 0），upsertUserFromMetadata 才会跳过
        // 该列而不是把 0 写进「不知道」的位置。
        const followers = toInt(props.followers_count);
        const posts = toInt(props.post_count);
        if (followers === undefined) delete props.followers_count; else props.followers_count = followers;
        if (posts === undefined) delete props.post_count; else props.post_count = posts;

        const sourceUserId = String(props.source_user_id ?? item.id ?? "");
        if (!sourceUserId) continue;

        try {
          await usersService.upsertUserFromMetadata(
            item as unknown as Record<string, unknown>,
            props,
            ctx.accountChannelId,
            SUBSCRIBED_CHANNEL_TYPE,
            YT_USER_META
          );
          refreshed++;
        } catch (e) {
          // 一行写失败不能拖垮整轮 —— 否则这个账号会在每次 tick 上用同一行卡死。故意
          // **不**把 completeWalk 按到 false：取消订阅的判定只看 walk.ids 是否完整
          // （见下方），与某一行资料是否写入成功无关；这个频道本来就在 walk.ids 里，
          // 不会被 diff 当成「取消订阅」，只是资料这次没刷新成功，下次 tick 再试。
          console.error(JSON.stringify({
            event: "youtube_channel_upsert_error",
            account_channel_id: ctx.accountChannelId, channel_id: sourceUserId, error: String(e),
          }));
        }
      }
    }
  } finally {
    // 无论 try 块是正常结束、continue 过、还是意外抛出，本轮已经花掉的配额都必须记账 ——
    // 一次也不记等于用了配额却没算数，而恰恰是大账号/多页、最可能中途出问题的那些运行
    // 花的配额最多（Important 2）。
    //
    // 只在结束时记一次、而不是每次请求各记一次：YouTube quota 计数器是单个 KV key 的
    // 读-改-写，Cloudflare KV 对同一个 key 有 **每秒 1 次写入** 的限流 —— 一个上千订阅
    // 的账号按每批各记一次，几秒内就会打满这个 key 的写入频率并触发限流报错，这才是
    // 「必须合并成一次」的决定性理由（RMW 竞态只是次要理由：同一次 invocation 内部并不
    // 存在并发，但多次读旧值+1 本身就是不必要的多余往返）。
    if (apiCalls > 0) await recordYouTubeQuota(ctx.env, apiCalls);
  }

  if (completeWalk) {
    // Critical fix：diff 的「谁还订阅着」必须用 walk.ids（subscriptions.list 的权威结果），
    // 不能用 channels.list 实际返回了资料的那些 id。两者会不一致：YouTube 对被删除/终止/
    // 地区屏蔽的频道会在 channels.list 里缄默（明明订阅关系还在，snippet/statistics 拿不到），
    // 一个 200 但截断/畸形的 body 也可能被误读成「这批频道都不存在」。用 channels.list 的
    // 结果做 diff，会把这些仍在订阅、只是这次没描述出来的频道误判为取消订阅并置 0 ——
    // 这正是本函数要严防的那类错误。walk.ids 权威、channels.list 只是资料来源，仅此而已。
    // 任何一批 channels.list 失败都已经把 completeWalk 按到 false（上面），diff 因此
    // 永远不会在权威列表残缺时执行 —— walk.ids 在这个分支里必然是完整的。
    const authoritative = new Set(walk.ids);

    const stillFollowed = await ctx.tenantDb.query<{ source_user_id: string }>(
      "SELECT source_user_id FROM user WHERE channel_id = ? AND channel_type = ? AND is_follow = 1",
      [ctx.accountChannelId, SUBSCRIBED_CHANNEL_TYPE]
    );

    if (authoritative.size === 0 && stillFollowed.length > 0) {
      // Important 1 floor guard：即使 completeWalk 为 true，一次把整个账号的订阅清空
      // 也是爆炸半径最大的错误场景（例如 subscriptions.list 对一个仍有大量订阅的账号
      // 200 回了 items: []，这种畸形/异常响应目前的分页逻辑无法百分百排除）。数据准确性
      // 优先于「这次也把状态更新掉」，宁可这一轮什么都不做，也不要一次性误清空全账号。
      console.error(JSON.stringify({
        event: "youtube_subscriptions_diff_skipped_empty_result",
        account_channel_id: ctx.accountChannelId,
        reason: "authoritative subscription list is empty while rows are still followed",
        still_followed_count: stillFollowed.length,
      }));
    } else {
      const gone = stillFollowed.filter((r) => !authoritative.has(r.source_user_id));
      for (const row of gone) {
        // 逻辑删除：不知道就置 is_follow=0，行本身保留（CLAUDE.md「重要的被关联数据用逻辑删除」）。
        await usersService.setFollowState(ctx.accountChannelId, SUBSCRIBED_CHANNEL_TYPE, row.source_user_id, { is_follow: 0 });
      }
      if (gone.length > 0) {
        console.log(JSON.stringify({
          event: "youtube_subscriptions_unfollowed",
          account_channel_id: ctx.accountChannelId, count: gone.length,
        }));
      }
    }
  } else {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_diff_skipped",
      account_channel_id: ctx.accountChannelId,
      reason: "incomplete_walk",
    }));
  }

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'subscriptions'")
    .bind(ctx.accountChannelId)
    .run();

  console.log(JSON.stringify({
    event: "youtube_subscriptions_poll_complete",
    account_channel_id: ctx.accountChannelId, upserted: refreshed, completeWalk,
  }));
}
