import type { ContentService } from "../content";
import { listReleases, getRepo, type GitHubRelease } from "../github-api";
import { resolveProps, resolveAuthorProps } from "./resolve-props";
import { ContentMetadata_GitHub } from "../../../../metadata/github";
import { runPagedPoll } from "./paged-poll";

// watch:get-releases 是 flowType:"trigger" —— 本路径只调 recordTriggerContentSeen +
// emitContentTriggerEvent，永不调 upsertContentFromMetadata，release 不进 content 表。
const GITHUB_METADATA = ContentMetadata_GitHub.find((m) => m.sourceContentType === "watch:get-releases")!;

/** Cloudflare Queues 单条消息上限 128KB；release body 偶尔上万字符，留足余量。 */
const MAX_CONTENT_TEXT = 32_768;
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 100;

/**
 * channel_poll_state 的 poller_name。ETag 与 seed 标记都是**每 repo** 的，而该表主键是
 * (channel_id, poller_name)，所以 repo 编码进 poller_name —— 与 x-list-posts 的
 * `list_posts:<listId>` 同一手法。
 */
export function pollerNameFor(fullName: string): string {
  return `github-releases:${fullName}`;
}

/**
 * 近 30 天的发版历史，供 flow 侧按节点的 includePrerelease 算 1d/7d/30d 三个计数。
 * 计数不能在这里算：口径取决于节点配置，而轮询按 repo 走，同一个 repo 可能被两个
 * 勾选框状态不同的 flow 盯着。
 */
export function buildReleaseHistory(
  releases: GitHubRelease[],
  now: number
): { published_at: string; prerelease: boolean }[] {
  return releases
    .filter((r) => !r.draft && r.published_at !== null)
    .filter((r) => now - Date.parse(r.published_at as string) <= HISTORY_WINDOW_MS)
    .slice(0, MAX_HISTORY)
    .map((r) => ({ published_at: r.published_at as string, prerelease: r.prerelease === true }));
}

export interface GitHubReleasePollerContext {
  channelId: string;
  fullName: string;
  token: string;
  tenantId: number;
  linkDb: D1Database;
  contentService: ContentService;
  /** 注入的「现在」——测试要确定性，生产传 Date.now()。 */
  now: number;
}

/** ETag 存在 channel_poll_state.cursor 里。latest-page 模式的 runPagedPoll 从不读写 cursor
 *  （只有 markBackfillComplete 在 seed 结束时置 NULL 一次），所以这里自持读写不会冲突；
 *  seed 那一轮写进去的 ETag 会被随后的 markBackfillComplete 抹掉，下一轮重新写入即可。 */
async function readEtag(ctx: GitHubReleasePollerContext): Promise<string | null> {
  const row = await ctx.linkDb
    .prepare("SELECT cursor FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(ctx.channelId, pollerNameFor(ctx.fullName))
    .first<{ cursor: string | null }>();
  return row?.cursor ?? null;
}

async function writeEtag(ctx: GitHubReleasePollerContext, etag: string | null): Promise<void> {
  if (!etag) return;
  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
    .bind(etag, ctx.channelId, pollerNameFor(ctx.fullName))
    .run();
}

/**
 * (channel, repo) 第一次被盯上时自建 poll-state 行。GitHub 的 repo 是在 flow 节点里选的，
 * OAuth 回调时还不知道要盯谁，所以不能像 TikTok 那样在连接时 seed —— 没有这一步，
 * runPagedPoll 会走 "skipped_not_seeded" 分支永远不干活。
 * （youtube-subscriptions.ts 出于同样的理由自 seed。）
 */
export async function ensurePollStateRow(ctx: GitHubReleasePollerContext): Promise<void> {
  await ctx.linkDb
    .prepare(
      `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
       VALUES (?, ?, NULL, 0, NULL, datetime('now'))
       ON CONFLICT(channel_id, poller_name) DO NOTHING`
    )
    .bind(ctx.channelId, pollerNameFor(ctx.fullName))
    .run();
}

export async function runGitHubReleasePoller(ctx: GitHubReleasePollerContext): Promise<void> {
  await ensurePollStateRow(ctx);

  await runPagedPoll<{ items: unknown[]; nextCursor: string | null; rateLimited: boolean }>({
    linkDb: ctx.linkDb,
    channelId: ctx.channelId,
    pollerName: pollerNameFor(ctx.fullName),
    // /releases 一次就是完整最新页，没有增量游标可用；靠 dedup 决定什么是新的。
    mode: "latest-page",
    // latest-page 模式只取一页、不做分页循环，deadline 只在 paged 模式被检查。
    deadline: Number.MAX_SAFE_INTEGER,
    logPrefix: "github_releases_poll",
    logContext: { repo: ctx.fullName },
    fetchPage: async () => {
      const etag = await readEtag(ctx);
      const r = await listReleases(ctx.token, ctx.fullName, etag);
      if (r.rateLimited) return { items: [], nextCursor: null, rateLimited: true };
      // 304 与 notFound 都当作「本轮没有可处理的内容」，不是错误：304 是内容没变，
      // notFound 是 repo 删了/转私有/无权访问 —— 都不该让整轮失败。
      if (r.releases === null) {
        if (r.notFound) console.log(JSON.stringify({ event: "github_releases_repo_unavailable", channel_id: ctx.channelId, repo: ctx.fullName }));
        return { items: [], nextCursor: null, rateLimited: false };
      }
      await writeEtag(ctx, r.etag);
      return { items: r.releases, nextCursor: null, rateLimited: false };
    },
    upsertPage: (page, emitFlowEvent) => upsertPage(ctx, page.items as GitHubRelease[], emitFlowEvent),
  });
}

async function upsertPage(
  ctx: GitHubReleasePollerContext,
  releases: GitHubRelease[],
  emitFlowEvent: boolean
): Promise<number> {
  const fresh: GitHubRelease[] = [];
  for (const r of releases) {
    // draft 只有有 push 权限的人可见，Watch 的 repo 本来拿不到；显式跳过是防线。
    if (r.draft) continue;
    if (!r.published_at) continue;
    // ALWAYS record，包括 seed 阶段（emitFlowEvent=false）：dedup 表是「见过」状态的唯一
    // 存放处，seed 时不记录，第一次增量轮询就会把整个历史当新的灌进 flow。
    const isNew = await ctx.contentService.recordTriggerContentSeen(ctx.channelId, ctx.fullName, String(r.id));
    // 收集与发射分开：返回值（新增条数）在 seed 阶段也要准确，runPagedPoll 用它记日志；
    // 发不发由下面的 emitFlowEvent 决定。
    if (isNew) fresh.push(r);
  }
  if (!emitFlowEvent || fresh.length === 0) return fresh.length;

  // 作者字段只在真有新版这一轮才拉 —— /releases 的响应不含 repo 信息（实测确认），
  // 而绝大多数轮次没有新版，每轮都打就是白烧一半配额。
  const repoResult = await getRepo(ctx.token, ctx.fullName);
  // 取不到 repo 就带着缺失的作者字段照发，**不能**跳过：上面的 recordTriggerContentSeen
  // 已经把这条 release 永久标记成「见过」了，跳过就是永久丢失，而下一轮不会补。
  // 但要把原因记清楚——限流是暂时的，仓库没了是永久的，日志里分辨得出来才有得查。
  if (!repoResult.repo) {
    console.log(JSON.stringify({
      event: "github_release_author_unavailable",
      channel_id: ctx.channelId, repo: ctx.fullName,
      reason: repoResult.rateLimited ? "rate_limited" : repoResult.notFound ? "not_found" : "unknown",
      degraded_releases: fresh.map((r) => r.id),
    }));
  }
  const authorProps = repoResult.repo && GITHUB_METADATA.userProps
    ? resolveAuthorProps(repoResult.repo, GITHUB_METADATA.userProps)
    : {};
  const history = buildReleaseHistory(releases, ctx.now);

  for (const r of fresh) {
    const props = resolveProps(r as unknown as Record<string, unknown>, GITHUB_METADATA.contentProps);
    // 很多 repo 不填 release name；空标题在下游（AI 提示词、卡片显示）比 tag 名更没用。
    if (!props.title) props.title = r.tag_name;
    // GitHub 返回布尔，metadata 声明的是 ENUM_INT。归一在这里做，flow 侧的匹配器
    // 严格比 !== 1，不接受布尔。
    props.is_prerelease = r.prerelease === true ? 1 : 0;
    if (typeof props.content_text === "string" && props.content_text.length > MAX_CONTENT_TEXT) {
      console.log(JSON.stringify({
        event: "github_release_body_truncated",
        channel_id: ctx.channelId, repo: ctx.fullName, release_id: r.id,
        original_length: props.content_text.length,
      }));
      props.content_text = props.content_text.slice(0, MAX_CONTENT_TEXT);
    }
    props.release_history = history;

    // envelope 用 owner/repo 全名而不是 repo 数字 id：节点里存的、/internal/github-watches
    // 返回的、选择器展示的都是全名，用数字 id 匹配器就无从比对了。
    await ctx.contentService.emitContentTriggerEvent(
      ctx.channelId, "GITHUB", "repoFullName", ctx.fullName, { ...props, ...authorProps }
    );
  }
  return fresh.length;
}
