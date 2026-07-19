import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { ContentService } from "../content";
import { fetchVideoDetails, parseISO8601Duration } from "../youtube-api";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

const YOUTUBE_METADATA = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

export interface YouTubeIngestContext {
  accountChannelId: string;
  subscriptionChannelId: string;
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  apiKey: string;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
}

export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const item = await fetchVideoDetails(ctx.apiKey, videoId);
  if (!item) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  props.duration = durationIso ? parseISO8601Duration(durationIso) : 0;

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const sourceContentId = String(props.source_content_id ?? "");
  const isNew = await contentService.recordTriggerContentSeen(ctx.accountChannelId, ctx.subscriptionChannelId, sourceContentId);
  if (isNew) {
    await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, props);
  }
  console.log(JSON.stringify({ event: "youtube_video_ingested", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, isNew }));
}
