import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { ContentService } from "../content";
import { fetchListPostsPage } from "../x-posts-api";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";

const LIST_POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;

export interface ListPostsPollerContext {
  channelId: string;
  listId: string;
  accessToken: string;
  linkDb: D1Database;
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

function pollerName(listId: string): string {
  return `list_posts:${listId}`;
}

export async function runListPostsPoller(ctx: ListPostsPollerContext): Promise<void> {
  const name = pollerName(ctx.listId);
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(ctx.channelId, name)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "list_posts_poll_skipped_not_seeded", channel_id: ctx.channelId, list_id: ctx.listId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "list_posts_poll_started", channel_id: ctx.channelId, list_id: ctx.listId, phase, cursor: state.cursor }));

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
  listId: string,
  emitFlowEvent: boolean
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, LIST_POSTS_METADATA.contentProps, LIST_POSTS_METADATA.linkPrefix);
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X", emitFlowEvent, listId);
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: ListPostsPollerContext,
  contentService: ContentService,
  startCursor: string | null
): Promise<void> {
  let cursor = startCursor || undefined;
  let pagesFetched = 0;
  const name = pollerName(ctx.listId);

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchListPostsPage(ctx.accessToken, ctx.listId, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "list_posts_poll_rate_limited", channel_id: ctx.channelId, list_id: ctx.listId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(contentService, page.data, ctx.channelId, ctx.listId, false);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?"
        )
        .bind(ctx.channelId, name)
        .run();
      console.log(JSON.stringify({ event: "list_posts_poll_backfill_complete", channel_id: ctx.channelId, list_id: ctx.listId, pagesFetched }));
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
      .bind(cursor, ctx.channelId, name)
      .run();
  }

  console.log(JSON.stringify({ event: "list_posts_poll_deadline_reached", channel_id: ctx.channelId, list_id: ctx.listId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: ListPostsPollerContext, contentService: ContentService): Promise<void> {
  const name = pollerName(ctx.listId);
  // List Tweets has no since_id parameter (unlike the user-tweets timeline endpoint) — each
  // cycle fetches only the latest page and relies on the dedup index to determine what's new,
  // per the design spec's accepted v1 limitation (a burst of more-than-one-page of new posts
  // within a single poll interval could miss the oldest of that batch).
  const { page, rateLimited } = await fetchListPostsPage(ctx.accessToken, ctx.listId);
  if (rateLimited) {
    console.log(JSON.stringify({ event: "list_posts_poll_rate_limited", channel_id: ctx.channelId, list_id: ctx.listId, phase: "incremental" }));
    return;
  }

  const newCount = await upsertPage(contentService, page.data, ctx.channelId, ctx.listId, true);
  console.log(JSON.stringify({ event: "list_posts_poll_incremental_complete", channel_id: ctx.channelId, list_id: ctx.listId, fetched: page.data.length, newCount }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
    .bind(ctx.channelId, name)
    .run();
}
