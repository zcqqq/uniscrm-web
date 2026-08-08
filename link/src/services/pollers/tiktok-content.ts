import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "../content";
import { fetchVideoListPage } from "../tiktok-content-api";
import { resolveProps, consumedPaths } from "./resolve-props";
import { ContentMetadata_TikTok } from "../../../../metadata/tiktok";
import { runPagedPoll, type PolledPage } from "./paged-poll";

const VIDEO_METADATA = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video.list")!;

export interface TikTokContentPollerContext {
  channelId: string;
  accessToken: string;
  linkDb: D1Database;
  // Per-tenant D1 — the source of truth (2026-07-26 plan). poll-channel.ts resolves this once
  // per channel and skips the whole poll before it ever gets here when the tenant has no
  // provisioned database. No entityState field (see x-posts.ts's identical note): the D1
  // column-compare inside upsertContentFromMetadata replaced the entity_state fingerprint here.
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
  deadline: number;
}

// Adapter over paged-poll.ts, which owns every paging/state invariant. No since_id watermark:
// TikTok's video.list has no since parameter — incremental rounds page from the top and stop
// at the first page with zero new videos. TikTokUnauthorizedError thrown by fetchVideoListPage
// escapes through runPagedPoll unchanged to poll-channel.ts's token-refresh retry.
export async function runTikTokContentPoller(ctx: TikTokContentPollerContext): Promise<void> {
  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);

  await runPagedPoll({
    linkDb: ctx.linkDb,
    channelId: ctx.channelId,
    pollerName: "content",
    deadline: ctx.deadline,
    mode: "paged",
    logPrefix: "tiktok_content_poll",
    fetchPage: async ({ cursor }) => {
      // channel_poll_state.cursor is text; TikTok's cursor is numeric. "" (persisted when the
      // API said has_more without a cursor value) deserializes back to undefined, same as the
      // pre-adapter behavior.
      const { page, rateLimited } = await fetchVideoListPage(ctx.accessToken, cursor ? Number(cursor) : undefined);
      // has_more drives continuation; the cursor value itself may be absent.
      return { items: page.data, nextCursor: page.hasMore ? String(page.nextCursor ?? "") : null, rateLimited };
    },
    upsertPage: (page: PolledPage, emitFlowEvent: boolean) =>
      upsertPage(contentService, page.items as Record<string, unknown>[], ctx.channelId, emitFlowEvent),
  });
}

async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  channelId: string,
  emitFlowEvent: boolean
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, VIDEO_METADATA.contentProps, VIDEO_METADATA.linkPrefix);
    // TikTok's create_time is Unix epoch seconds, unlike X's created_at (already
    // ISO8601) — PropMapping only supports fixed value/dataId extraction, so this
    // unit conversion stays here rather than in the declarative metadata (same
    // reasoning as x-posts.ts's item.article content_type fixup).
    if (typeof props.source_created_at === "number") {
      props.source_created_at = new Date(props.source_created_at * 1000).toISOString();
    }
    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // CONTENT_MAPPED_PROP_IDS restricts to propIds with an actual R2 `content` column —
    // content_url maps to the R2 `source_url` column (CONTENT_COLUMN_MAP in
    // services/content.ts), so it's excluded from raw_data like every other mapped prop.
    const paths = consumedPaths(VIDEO_METADATA.contentProps, VIDEO_METADATA.linkPrefix, CONTENT_MAPPED_PROP_IDS);
    // flowType comes from the metadata entry itself (spec's flowType table: video.list is
    // "content"), never a literal — see content.ts's upsertContentFromMetadata gate.
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "TIKTOK", emitFlowEvent, undefined, paths, VIDEO_METADATA.flowType);
    if (isNew) newCount++;
  }
  return newCount;
}
