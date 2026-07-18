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
  backfill_complete: number;
  last_polled_at: string | null;
}

function pollerName(listId: string): string {
  return `list_posts:${listId}`;
}

export async function runListPostsPoller(ctx: ListPostsPollerContext): Promise<void> {
  const name = pollerName(ctx.listId);
  const state = await ctx.linkDb
    .prepare("SELECT backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(ctx.channelId, name)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "list_posts_poll_skipped_not_seeded", channel_id: ctx.channelId, list_id: ctx.listId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const phase = state.backfill_complete ? "incremental" : "seed";
  console.log(JSON.stringify({ event: "list_posts_poll_started", channel_id: ctx.channelId, list_id: ctx.listId, phase }));

  if (!state.backfill_complete) {
    await seedFromLatestPage(ctx, contentService);
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

async function seedFromLatestPage(ctx: ListPostsPollerContext, contentService: ContentService): Promise<void> {
  const name = pollerName(ctx.listId);

  // List Posts triggers exist to react to NEW content, not to import a list's full history —
  // a multi-page historical crawl can take hours (X's List Tweets endpoint is tightly rate
  // limited) and silently keeps the trigger dark the whole time. So the first-ever poll for a
  // watch fetches only today's latest page (ignoring any older pages via next_token) to seed the
  // dedup index with what already exists (emitFlowEvent=false), then goes straight to "complete"
  // so the very next cron cycle is a normal incremental poll.
  const { page, rateLimited } = await fetchListPostsPage(ctx.accessToken, ctx.listId);
  if (rateLimited) {
    console.log(JSON.stringify({ event: "list_posts_poll_rate_limited", channel_id: ctx.channelId, list_id: ctx.listId, phase: "seed" }));
    return;
  }

  await upsertPage(contentService, page.data, ctx.channelId, ctx.listId, false);

  await ctx.linkDb
    .prepare(
      "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?"
    )
    .bind(ctx.channelId, name)
    .run();
  console.log(JSON.stringify({ event: "list_posts_poll_seed_complete", channel_id: ctx.channelId, list_id: ctx.listId, fetched: page.data.length }));
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
