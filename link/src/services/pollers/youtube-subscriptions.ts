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
  // channels.list（无论成功失败，请求都已经发出、配额已经计费）。只在结束时记账一次，
  // 避免对同一个 KV 计数器做多次「读旧值再+1」而互相覆盖。
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

  const seen = new Set<string>();
  for (let i = 0; i < walk.ids.length; i += CHANNELS_BATCH_SIZE) {
    if (Date.now() >= ctx.deadline) {
      // 还有批次没跑完 —— 本轮的「订阅列表」是残缺的，不能拿来判定取消订阅。
      completeWalk = false;
      console.log(JSON.stringify({
        event: "youtube_subscriptions_poll_deadline",
        account_channel_id: ctx.accountChannelId, processed: seen.size,
      }));
      break;
    }

    const batch = walk.ids.slice(i, i + CHANNELS_BATCH_SIZE);
    apiCalls++;
    let items: YouTubeChannelItem[];
    try {
      items = await fetchChannelDetails(ctx.accessToken, batch);
    } catch (e) {
      // 这一批的频道本轮没拿到数据，因此它们「不在本次结果里」不能被解释成取消订阅。
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
      seen.add(sourceUserId);

      await usersService.upsertUserFromMetadata(
        item as unknown as Record<string, unknown>,
        props,
        ctx.accountChannelId,
        SUBSCRIBED_CHANNEL_TYPE,
        YT_USER_META
      );
    }
  }

  if (apiCalls > 0) await recordYouTubeQuota(ctx.env, apiCalls);

  if (completeWalk) {
    // 只有完整走查才允许判定取消订阅。半份列表做 diff 会把仍在订阅的频道误置 0 ——
    // 数据准确性优先于「这次也把状态更新掉」。
    const stillFollowed = await ctx.tenantDb.query<{ source_user_id: string }>(
      "SELECT source_user_id FROM user WHERE channel_id = ? AND channel_type = ? AND is_follow = 1",
      [ctx.accountChannelId, SUBSCRIBED_CHANNEL_TYPE]
    );
    const gone = stillFollowed.filter((r) => !seen.has(r.source_user_id));
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
    account_channel_id: ctx.accountChannelId, upserted: seen.size, completeWalk,
  }));
}
