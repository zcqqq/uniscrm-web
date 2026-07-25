import type { Pipeline } from "../../types";
import type { R2SqlEnv } from "../../../../shared/r2-sql";
import { EntityStateStore } from "../entity-state";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "../content";
import { fetchVideoListPage } from "../tiktok-content-api";
import { resolveProps, consumedPaths } from "./resolve-props";
import { ContentMetadata_TikTok } from "../../../../metadata/tiktok";

const VIDEO_METADATA = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video.list")!;

export interface TikTokContentPollerContext {
  channelId: string;
  accessToken: string;
  linkDb: D1Database;
  entityState: EntityStateStore;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
  r2Env?: R2SqlEnv;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runTikTokContentPoller(ctx: TikTokContentPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'content'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "tiktok_content_poll_skipped_not_seeded", channel_id: ctx.channelId }));
    return;
  }

  const contentService = new ContentService(ctx.entityState, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue, ctx.r2Env);
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "tiktok_content_poll_started", channel_id: ctx.channelId, phase, cursor: state.cursor }));

  if (!state.backfill_complete) {
    await runBackfill(ctx, contentService, state.cursor ? Number(state.cursor) : undefined);
  } else {
    await runIncrementalPoll(ctx, contentService);
  }
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
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "TIKTOK", emitFlowEvent, undefined, paths);
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: TikTokContentPollerContext,
  contentService: ContentService,
  startCursor: number | undefined
): Promise<void> {
  let cursor = startCursor;
  let pagesFetched = 0;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchVideoListPage(ctx.accessToken, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "tiktok_content_poll_rate_limited", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(contentService, page.data, ctx.channelId, false);

    if (!page.hasMore) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'"
        )
        .bind(ctx.channelId)
        .run();
      console.log(JSON.stringify({ event: "tiktok_content_poll_backfill_complete", channel_id: ctx.channelId, pagesFetched }));
      return;
    }

    cursor = page.nextCursor;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'")
      .bind(String(cursor ?? ""), ctx.channelId)
      .run();
  }

  console.log(JSON.stringify({ event: "tiktok_content_poll_deadline_reached", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: TikTokContentPollerContext, contentService: ContentService): Promise<void> {
  let cursor: number | undefined;
  let pagesFetched = 0;
  let totalNew = 0;
  let stopReason: "rate_limited" | "no_new_content" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchVideoListPage(ctx.accessToken, cursor);
    if (rateLimited) { stopReason = "rate_limited"; break; }

    pagesFetched++;
    const newCount = await upsertPage(contentService, page.data, ctx.channelId, true);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_content"; break; }
    if (!page.hasMore) { stopReason = "no_next_page"; break; }
    cursor = page.nextCursor;
  }

  console.log(JSON.stringify({ event: "tiktok_content_poll_incremental_complete", channel_id: ctx.channelId, pagesFetched, totalNew, stopReason }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'")
    .bind(ctx.channelId)
    .run();
}
