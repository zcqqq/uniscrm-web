import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { EntityStateStore } from "../entity-state";
import { ContentService } from "../content";
import { fetchVideoDetails, parseISO8601Duration } from "../youtube-api";
import { resolveProps } from "./resolve-props";
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

// videos.list 的一条 item → 已按 metadata 映射好的 contentProps。ingest 路径与 flow 的
// youtubeCondition 节点（经 /internal/youtube/video-stats）共用这一份实现：字段怎么映射
// 只能有一个答案，否则 metadata 改一次得记得改两处。
// 返回 null = videos.list 没返回这个视频（已删除、转私密、id 不存在）——不是错误，是"没有"。
export async function fetchYouTubeVideoProps(
  apiKey: string,
  videoId: string
): Promise<Record<string, unknown> | null> {
  const item = await fetchVideoDetails(apiKey, videoId);
  if (!item) return null;

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  // Leave props.duration unset (not a fake 0) when we can't parse it — e.g. live/upcoming
  // broadcasts ("P0D") or videos over 24h. passesPropsFilter fails closed on a missing prop.
  const parsedDuration = durationIso ? parseISO8601Duration(durationIso) : null;
  if (parsedDuration !== null) {
    props.duration = parsedDuration;
  }
  return props;
}

export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const props = await fetchYouTubeVideoProps(ctx.apiKey, videoId);
  if (!props) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue, ctx.entityState);
  const sourceContentId = String(props.source_content_id ?? "");
  const isNew = await contentService.recordTriggerContentSeen(ctx.accountChannelId, ctx.subscriptionChannelId, sourceContentId);
  if (isNew) {
    if (passesPropsFilter(YOUTUBE_METADATA.contentPropsFilter, props)) {
      await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, props);
    } else {
      console.log(JSON.stringify({ event: "youtube_content_skipped_filter", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, duration: props.duration }));
    }
  }
  console.log(JSON.stringify({ event: "youtube_video_ingested", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, isNew }));
}
