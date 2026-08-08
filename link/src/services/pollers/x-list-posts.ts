import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { EntityStateStore } from "../entity-state";
import { ContentService } from "../content";
import { fetchListPostsPage } from "../x-posts-api";
import { resolveProps, resolveAuthorProps } from "./resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";
import { runPagedPoll, type PolledPage } from "./paged-poll";

// get-list-posts is flowType:"trigger" in ContentMetadata_X (spec's flowType table) — this
// poller only ever calls recordTriggerContentSeen + emitContentTriggerEvent below, never
// upsertContentFromMetadata, so a List Posts watch is never persisted into `content`.
const LIST_POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;

export interface ListPostsPollerContext {
  channelId: string;
  listId: string;
  accessToken: string;
  linkDb: D1Database;
  // Per-tenant D1 — poll-channel.ts resolves this once per channel before any poller runs, but
  // this poller's own D1 calls (recordTriggerContentSeen/emitContentTriggerEvent) don't need
  // it, only entityState below — see the flowType comment above.
  tenantDb: TenantDataDB | null;
  entityState: EntityStateStore;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
  deadline: number;
}

// authors rides along on the adapter's page type — paged-poll.ts reads only the PolledPage
// core fields and hands the whole page back to upsertPage.
interface ListPostsPage extends PolledPage {
  authors?: Record<string, Record<string, unknown>>;
}

// Adapter over paged-poll.ts in "latest-page" mode: the first-ever poll seeds the dedup index
// from ONE latest page (a multi-page historical crawl can take hours on X's tightly
// rate-limited List Tweets endpoint and would keep the trigger dark the whole time), then
// every cycle fetches only the latest page — List Tweets has no since_id parameter, so what's
// new is decided by the entity_state dedup, per the design spec's accepted v1 limitation (a
// burst of more-than-one-page of new posts within one poll interval could miss the oldest).
// XUnauthorizedError / XAccountFrozenError escape unchanged to poll-channel.ts's retry/breaker.
export async function runListPostsPoller(ctx: ListPostsPollerContext): Promise<void> {
  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue, ctx.entityState);

  await runPagedPoll<ListPostsPage>({
    linkDb: ctx.linkDb,
    channelId: ctx.channelId,
    pollerName: `list_posts:${ctx.listId}`,
    deadline: ctx.deadline,
    mode: "latest-page",
    logPrefix: "list_posts_poll",
    logContext: { list_id: ctx.listId },
    fetchPage: async () => {
      const { page, rateLimited } = await fetchListPostsPage(ctx.accessToken, ctx.listId);
      // nextCursor stays null on purpose: latest-page mode never paginates (see above).
      return { items: page.data, authors: page.authors, nextCursor: null, rateLimited };
    },
    upsertPage: (page, emitFlowEvent) =>
      upsertPage(contentService, page.items as Record<string, unknown>[], page.authors, ctx.channelId, ctx.listId, emitFlowEvent),
  });
}

async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  authors: Record<string, Record<string, unknown>> | undefined,
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
    // X's tweet.fields has no permalink field; x.com/i/status/{id} is the official,
    // username-independent status URL format.
    props.content_url = `https://x.com/i/status/${props.source_content_id}`;
    // 作者字段（user.* 命名空间）与内容字段一起进 flow payload。作者对象就在同一个响应的
    // includes.users[] 里，零额外配额。匹配不到（作者被封/受保护，X 会省略）就不带
    // user.*——照常发内容，引用作者字段的条件按 fail-closed 不通过，没配作者条件的 flow
    // 完全不受影响。整条跳过是错的：recordTriggerContentSeen 已经把它记成"见过"。
    const authorId = typeof item.author_id === "string" ? item.author_id : "";
    const author = authorId ? authors?.[authorId] : undefined;
    const authorProps = author && LIST_POSTS_METADATA.userProps
      ? resolveAuthorProps(author, LIST_POSTS_METADATA.userProps)
      : {};
    const sourceContentId = String(props.source_content_id ?? "");
    // ALWAYS record, including during the seed phase (emitFlowEvent=false) — the dedup table
    // is the only place "already seen" state lives now, so skipping the record during seed
    // would make the first incremental poll see the whole seeded backlog as new and flood the
    // flow with duplicate triggers.
    const isNew = await contentService.recordTriggerContentSeen(channelId, listId, sourceContentId);
    if (isNew) newCount++;
    if (isNew && emitFlowEvent) {
      await contentService.emitContentTriggerEvent(channelId, "X", "listId", listId, { ...props, ...authorProps });
    }
  }
  return newCount;
}
