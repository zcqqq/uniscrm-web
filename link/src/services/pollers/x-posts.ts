import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "../content";
import { fetchPostsPage } from "../x-posts-api";
import { resolveProps, consumedPaths } from "./resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";

const POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;

export interface PostsPollerContext {
  channelId: string;
  xUserId: string;
  accessToken: string;
  linkDb: D1Database;
  // Per-tenant D1 — the source of truth (2026-07-26 plan). poll-channel.ts resolves this once
  // per channel and skips the whole poll before it ever gets here when the tenant has no
  // provisioned database, so it is always real by the time runPostsPoller runs. No entityState
  // field here (unlike x-followers.ts / x-list-posts.ts): upsertContentFromMetadata's D1
  // column-compare replaced the entity_state fingerprint on this path entirely.
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runPostsPoller(ctx: PostsPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'posts'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "posts_poll_skipped_not_seeded", channel_id: ctx.channelId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "posts_poll_started", channel_id: ctx.channelId, phase, cursor: state.cursor }));

  if (!state.backfill_complete) {
    await runBackfill(ctx, contentService, state.cursor);
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
    const props = resolveProps(item, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
    // X Articles come back as a tweet with an extra `article` object (see
    // _reference/x/post.json); PropMapping only supports fixed value/dataId extraction,
    // so this presence check stays here rather than in the declarative metadata.
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    // X's tweet.fields has no permalink field; x.com/i/status/{id} is the official,
    // username-independent status URL format — same reasoning as the article fixup above.
    props.content_url = `https://x.com/i/status/${props.source_content_id}`;
    // raw_data 只保留没有被消费的字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    // CONTENT_MAPPED_PROP_IDS restricts to propIds that actually land in a named R2 `content`
    // column, so a mapped-but-columnless prop isn't stripped with nowhere else to land.
    const paths = consumedPaths(POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix, CONTENT_MAPPED_PROP_IDS);
    // flowType comes from the metadata entry itself (spec's flowType table: own:get-posts is
    // "content"), never a literal — see content.ts's upsertContentFromMetadata gate.
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X", emitFlowEvent, undefined, paths, POSTS_METADATA.flowType);
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: PostsPollerContext,
  contentService: ContentService,
  startCursor: string | null
): Promise<void> {
  let cursor = startCursor || undefined;
  let pagesFetched = 0;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchPostsPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "posts_poll_rate_limited", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(contentService, page.data, ctx.channelId, false);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'"
        )
        .bind(ctx.channelId)
        .run();
      console.log(JSON.stringify({ event: "posts_poll_backfill_complete", channel_id: ctx.channelId, pagesFetched }));
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'")
      .bind(cursor, ctx.channelId)
      .run();
  }

  console.log(JSON.stringify({ event: "posts_poll_deadline_reached", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: PostsPollerContext, contentService: ContentService): Promise<void> {
  let cursor: string | undefined;
  let pagesFetched = 0;
  let totalNew = 0;
  let stopReason: "rate_limited" | "no_new_content" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchPostsPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) { stopReason = "rate_limited"; break; }

    pagesFetched++;
    const newCount = await upsertPage(contentService, page.data, ctx.channelId, true);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_content"; break; }
    if (!page.nextToken) { stopReason = "no_next_page"; break; }
    cursor = page.nextToken;
  }

  console.log(JSON.stringify({ event: "posts_poll_incremental_complete", channel_id: ctx.channelId, pagesFetched, totalNew, stopReason }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'")
    .bind(ctx.channelId)
    .run();
}
