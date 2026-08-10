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

/**
 * 返回值只有一个用途：把「这个 channel 的 token 已经被 GitHub 限流」这件事送出去。
 * runPagedPoll 只把 rateLimited 当成「本轮别推进」的内部信号并吞掉，可 cron 侧必须知道 ——
 * 一个被限流的租户如果继续把它剩下的 repo 一个个打过去，每个都要 ~300ms 才换回一个 403，
 * 烧的是全平台共用的那份预算。cron 拿到 true 就把该 channel 加进 stoppedChannels。
 *
 * 注意 fetchPage 里 repo 不可读（404/403 无权）也走 rateLimited 这个出口（见那里的注释），
 * 但那**不是**限流，不能停掉整个 channel —— 所以这里只在 listReleases/getRepo 真的报了
 * rateLimited 时才置位。
 */
export async function runGitHubReleasePoller(ctx: GitHubReleasePollerContext): Promise<{ rateLimited: boolean }> {
  await ensurePollStateRow(ctx);

  const rateLimit = { hit: false };

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
    fetchPage: async ({ phase }) => {
      // seed 轮（latest-page 模式下 phase 报作 "backfill"）**不带** If-None-Match。
      // seed 的全部意义是把当前这一页灌进 dedup 表；一个 304 会让本轮拿到空页、被
      // markBackfillComplete 标记成「已 seed」，下一轮就把整个历史当新的发出去。
      // cursor 通常在 seed 时为 NULL，但不是必然：上一轮 seed 若在 writeEtag 之后、
      // markBackfillComplete 之前抛了（例如 upsertPage 里的 D1 报错），ETag 就留在了
      // cursor 里，下一轮 seed 正好撞上 304。不发这个头，这条路径就根本不存在。
      const etag = phase === "incremental" ? await readEtag(ctx) : null;
      const r = await listReleases(ctx.token, ctx.fullName, etag);
      if (r.rateLimited) {
        rateLimit.hit = true;
        return { items: [], nextCursor: null, rateLimited: true };
      }
      if (r.releases === null) {
        if (r.notFound) {
          console.log(JSON.stringify({ event: "github_releases_repo_unavailable", channel_id: ctx.channelId, repo: ctx.fullName, phase }));
          // 读不到的 repo（404 删除/转私有、403 无权）走**和限流同一个出口**。
          // rateLimited 这个名字没说这件事，所以说清楚：runPagedPoll 只认这一个标志位表示
          // 「本轮什么都别推进」—— 不 markBackfillComplete、不写 last_polled_at、下一轮重来。
          // 用 items: [] 走正常出口是错的：首轮 seed 会被以**空的 seen 集合**标记成已完成，
          // 下一轮把最多 100 条历史 release 一次性灌进用户的 flow —— 正是 seed 阶段存在的
          // 意义所要防的那场洪水。403 无权也可能是暂时的（组织权限变更后又恢复），
          // 与限流一样值得下一轮重试。
          return { items: [], nextCursor: null, rateLimited: true };
        }
        // 304：内容确实没变，是一轮正常的空轮次 —— 照常走完，好让 last_polled_at 推进。
        return { items: [], nextCursor: null, rateLimited: false };
      }
      await writeEtag(ctx, r.etag);
      return { items: r.releases, nextCursor: null, rateLimited: false };
    },
    upsertPage: (page, emitFlowEvent) => upsertPage(ctx, page.items as GitHubRelease[], emitFlowEvent, rateLimit),
  });

  return { rateLimited: rateLimit.hit };
}

async function upsertPage(
  ctx: GitHubReleasePollerContext,
  releases: GitHubRelease[],
  emitFlowEvent: boolean,
  rateLimit: { hit: boolean }
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
  //
  // 这次调用落在「已标记见过」与「已发出」之间的窗口里，所以**任何**失败都必须降级，
  // 不能让异常逃出去：getRepo 在 401/403/404/429 之外的状态码（如 500）和网络故障时会
  // 抛，而此刻 fresh 里每一条都已经被 recordTriggerContentSeen 永久标记成见过了 ——
  // 异常中断本轮 = 这些 release 永远发不出去，下一轮也不会补。
  // 三种失败在日志里必须分得开：限流是暂时的，仓库没了是永久的，抛错是要人去查的。
  let repo: Record<string, unknown> | null = null;
  let authorFailureReason: string | null = null;
  try {
    const repoResult = await getRepo(ctx.token, ctx.fullName);
    repo = repoResult.repo;
    if (!repo) authorFailureReason = repoResult.rateLimited ? "rate_limited" : repoResult.notFound ? "not_found" : "unknown";
    // getRepo 的限流同样是「这个 token 这轮打不动了」，一样要送到 cron 侧停掉本 channel。
    if (repoResult.rateLimited) rateLimit.hit = true;
  } catch (e) {
    // GitHubUnauthorizedError 也在这里被降级掉：本轮 fresh 的发射优先于让 channel 停摆，
    // 而 token 失效下一轮 listReleases 一样会抛，cron 侧照样能停掉这个 channel。
    authorFailureReason = "threw";
    console.error(JSON.stringify({
      event: "github_release_author_fetch_error",
      channel_id: ctx.channelId, repo: ctx.fullName, error: String(e),
    }));
  }
  // 取不到 repo 就带着缺失的作者字段照发，**不能**跳过（理由见上）。
  if (!repo) {
    console.log(JSON.stringify({
      event: "github_release_author_unavailable",
      channel_id: ctx.channelId, repo: ctx.fullName,
      reason: authorFailureReason,
      degraded_releases: fresh.map((r) => r.id),
    }));
  }
  const authorProps = repo && GITHUB_METADATA.userProps
    ? resolveAuthorProps(repo, GITHUB_METADATA.userProps)
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

    // 逐条兜住，别让一条的失败连坐后面的：mark 循环与 emit 循环在这里是分开的
    // （getRepo 必须夹在中间，且只在确有新版时才打），所以 x-list-posts 那种「逐条
    // mark+emit 配对、最多一条有风险」的写法在这条路径上做不到。退而求其次：每条 emit
    // 自己吞掉异常并把丢失的 release id 记进日志，让风险回到「最多一条」。
    // emitContentTriggerEvent 内部只 .catch() 了 send() 返回的 promise —— send() 同步抛
    // （序列化失败等）时那个 .catch 根本挂不上，异常照样逃出来，所以这层是必要的。
    try {
      // envelope 用 owner/repo 全名而不是 repo 数字 id：节点里存的、/internal/github-watches
      // 返回的、选择器展示的都是全名，用数字 id 匹配器就无从比对了。
      await ctx.contentService.emitContentTriggerEvent(
        ctx.channelId, "GITHUB", "repoFullName", ctx.fullName, { ...props, ...authorProps }
      );
    } catch (e) {
      // 已经被标记成见过、却没发出去 = 永久丢失，日志里必须留下足够定位的 id。
      console.error(JSON.stringify({
        event: "github_release_emit_failed",
        channel_id: ctx.channelId, repo: ctx.fullName, release_id: r.id, error: String(e),
      }));
    }
  }
  return fresh.length;
}
