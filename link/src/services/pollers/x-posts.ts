import type { Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "../content";
import { fetchPostsPage } from "../x-posts-api";
import { resolveProps, consumedPaths } from "./resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";
import { runPagedPoll, type PolledPage } from "./paged-poll";

const POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;

export interface PostsPollerContext {
  channelId: string;
  xUserId: string;
  accessToken: string;
  linkDb: D1Database;
  // Per-tenant D1 — the source of truth (2026-07-26 plan). poll-channel.ts resolves this once
  // per channel and skips the whole poll before it ever gets here when the tenant has no
  // provisioned database, so it is always real by the time runPostsPoller runs. No entityState
  // field here (unlike x-list-posts.ts): upsertContentFromMetadata's D1 column-compare
  // replaced the entity_state fingerprint on this path entirely.
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
  deadline: number;
}

// Adapter over paged-poll.ts, which owns every paging/state invariant — including this
// poller's since_id watermark rule (useSinceIdWatermark: advance only when all new pages were
// consumed). Errors from fetchPostsPage (XUnauthorizedError / XAccountFrozenError) escape
// through runPagedPoll unchanged to poll-channel.ts's token-refresh retry and freeze breaker.
export async function runPostsPoller(ctx: PostsPollerContext): Promise<void> {
  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);

  await runPagedPoll({
    linkDb: ctx.linkDb,
    channelId: ctx.channelId,
    pollerName: "posts",
    deadline: ctx.deadline,
    mode: "paged",
    // X 的 owned read 按返回条数计费（UTC 日内同一条去重）——增量轮询必须带 since_id 水位，
    // 否则每天第一次轮询都会把整份自有帖重新买一遍（见 x-posts-api.ts 的 since_id 注释）。
    useSinceIdWatermark: true,
    logPrefix: "posts_poll",
    fetchPage: async ({ cursor, sinceId }) => {
      const { page, rateLimited } = await fetchPostsPage(ctx.accessToken, ctx.xUserId, cursor || undefined, sinceId ?? undefined);
      return { items: page.data, nextCursor: page.nextToken || null, newestId: page.newestId, rateLimited };
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
