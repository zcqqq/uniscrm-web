import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { EntityStateStore } from "../entity-state";
import { ContentService } from "../content";
import { fetchVideoDetails, fetchChannelDetails, parseISO8601Duration } from "../youtube-api";
import { resolveProps, resolveAuthorProps } from "./resolve-props";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";
import { passesPropsFilter } from "../../../../metadata/props-filter";

// watch:get-videos is flowType:"trigger" in ContentMetadata_YouTube (spec's flowType table) —
// this ingest path only ever calls recordTriggerContentSeen + emitContentTriggerEvent below,
// never upsertContentFromMetadata, so a subscribed video is never persisted into `content`.
const YOUTUBE_METADATA = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

export interface YouTubeIngestContext {
  accountChannelId: string;
  subscriptionChannelId: string;
  // Per-tenant D1 — webhook-youtube.ts resolves this once per WebSub delivery before any
  // video is ingested, but this path's own D1 calls (recordTriggerContentSeen/
  // emitContentTriggerEvent) don't need it, only entityState below — see the flowType comment
  // above.
  tenantDb: TenantDataDB | null;
  entityState: EntityStateStore;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  apiKey: string;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
}

export interface YouTubeVideoProps {
  props: Record<string, unknown>;
  // videos.list 的 snippet 白送的作者频道 id。调用方拿它去打 channels.list 取作者字段。
  // 空串 = 响应里没有（不该发生，但不假设它一定在）。
  authorChannelId: string;
}

// videos.list 的一条 item → 已按 metadata 映射好的 contentProps + 作者频道 id。ingest
// 路径与 flow 的 youtubeCondition 节点（经 /internal/youtube/video-stats）共用这一份
// 实现：字段怎么映射只能有一个答案，否则 metadata 改一次得记得改两处。
// 返回 null = videos.list 没返回这个视频（已删除、转私密、id 不存在）——不是错误，是"没有"。
export async function fetchYouTubeVideoProps(
  apiKey: string,
  videoId: string
): Promise<YouTubeVideoProps | null> {
  const item = await fetchVideoDetails(apiKey, videoId);
  if (!item) return null;

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const snippet = item.snippet as Record<string, unknown> | undefined;
  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  // Leave props.duration unset (not a fake 0) when we can't parse it — e.g. live/upcoming
  // broadcasts ("P0D") or videos over 24h. passesPropsFilter fails closed on a missing prop.
  const parsedDuration = durationIso ? parseISO8601Duration(durationIso) : null;
  if (parsedDuration !== null) {
    props.duration = parsedDuration;
  }
  return {
    props,
    authorChannelId: typeof snippet?.channelId === "string" ? snippet.channelId : "",
  };
}

// 作者（频道）字段，键已加 user. 前缀。
// 返回 {} = 拿不到（channelId 为空、频道已删/已封）。API 错误**向上抛**——调用方对
// 「拿不到」有两种完全不同的处理：ingest 路径吞掉、照常发内容（跳过等于永久丢失这个
// 视频），condition 节点则必须走 failed 分支（绝不用缺失的作者数据去猜 true/false）。
export async function fetchYouTubeAuthorProps(
  apiKey: string,
  channelId: string
): Promise<Record<string, unknown>> {
  if (!channelId || !YOUTUBE_METADATA.userProps) return {};
  const channel = await fetchChannelDetails(apiKey, channelId);
  if (!channel) return {};
  return resolveAuthorProps(channel, YOUTUBE_METADATA.userProps);
}

export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const video = await fetchYouTubeVideoProps(ctx.apiKey, videoId);
  if (!video) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }
  const props = video.props;

  // 作者（频道）字段：与内容字段一起进 flow payload。多打一次 channels.list（1 unit）。
  // 失败不阻断——整条跳过等于永久丢失这个视频（recordTriggerContentSeen 下面就把它记成
  // "见过"，WebSub 只推一次，配额恢复也不会补）。拿不到就不带 user.*：引用作者字段的
  // 条件按 fail-closed 不通过，没配作者条件的 flow 完全不受影响。
  let authorProps: Record<string, unknown> = {};
  try {
    authorProps = await fetchYouTubeAuthorProps(ctx.apiKey, video.authorChannelId);
  } catch (e) {
    console.log(JSON.stringify({ event: "youtube_author_fetch_failed", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, author_channel_id: video.authorChannelId, error: String(e) }));
  }
  if (Object.keys(authorProps).length === 0) {
    console.log(JSON.stringify({ event: "youtube_author_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, author_channel_id: video.authorChannelId }));
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue, ctx.entityState);
  const sourceContentId = String(props.source_content_id ?? "");
  const isNew = await contentService.recordTriggerContentSeen(ctx.accountChannelId, ctx.subscriptionChannelId, sourceContentId);
  if (isNew) {
    // contentPropsFilter 只判内容字段（duration <= 600），作者字段不参与——它是 metadata
    // 声明的系统级限制，与用户在节点上配的条件是两回事。
    if (passesPropsFilter(YOUTUBE_METADATA.contentPropsFilter, props)) {
      await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, { ...props, ...authorProps });
    } else {
      console.log(JSON.stringify({ event: "youtube_content_skipped_filter", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, duration: props.duration }));
    }
  }
  console.log(JSON.stringify({ event: "youtube_video_ingested", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, isNew }));
}
