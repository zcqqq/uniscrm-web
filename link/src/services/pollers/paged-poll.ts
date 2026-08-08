// The one place the channel_poll_state paging invariants live. Every cursor-paged poller
// (x-posts, tiktok-content, x-list-posts) used to copy-paste this skeleton; they are now thin
// adapters over runPagedPoll, which owns:
//   - the poll-state probe + "not seeded" guard (no row / empty row = channel not authorized
//     yet — the OAuth-connect flow seeds the row, so polling before that is meaningless)
//   - the backfill-vs-incremental dispatch on backfill_complete
//   - per-page cursor persistence during backfill (a deadline kill mid-backfill resumes from
//     the last persisted page boundary next run)
//   - deadline checks between pages and rate-limit early-stop
//   - the backfill_complete transition (cursor cleared in the same UPDATE)
//   - the last_polled_at tail update that poll-channel.ts's shouldPoll throttling reads
//   - the since_id watermark rule (useSinceIdWatermark): the watermark only advances when the
//     incremental loop drained every new page (stopReason no_new_content / no_next_page).
//     Stopping on deadline or rate-limit means older-but-still-new posts are still owed; 推进
//     水位会把它们永久跳过 —— 宁可下一轮重拉一遍（同一 UTC 日内 X 对同一条资源只计一次费），
//     也不能丢数据。The rule lives here, not in the adapter, so it cannot drift per channel.
//
// What this module deliberately does NOT do: catch errors. XUnauthorizedError /
// XAccountFrozenError / TikTokUnauthorizedError thrown by fetchPage must escape to
// poll-channel.ts's token-refresh retry and freeze breaker unchanged.
//
// youtube-subscriptions.ts stays custom, on purpose. It shares the channel_poll_state table
// but almost nothing else: it self-seeds its row (no "not seeded" guard — YouTube's auth lives
// in channels.config, the row is only a throttle timestamp), has no backfill/incremental
// dispatch (every run re-walks the full subscriptions id list and its cursor is a batch INDEX
// into that fresh list, not an API page token), persists cursor + last_polled_at in a single
// finally-block UPDATE that must fire on every exit path including throws, does per-item (not
// per-page) deadline checks, accounts YouTube quota in a finally, and runs an unsubscribe diff
// only on completed rounds. Expressing that through this interface would mean hooks for
// pre-run seeding, finally-based persistence, and a diff-on-complete callback — contorting
// both sides for zero shared invariants. (youtube-content.ts is WebSub push ingest, not a
// poller, and is likewise out of scope here.)

/**
 * One fetched page in the unified contract. Adapters map their channel API's shape
 * (nextToken / hasMore+cursor / ...) into this; the module reads ONLY these fields and hands
 * the whole page back to upsertPage, so adapters may carry extra payload (e.g. x-list-posts'
 * authors map) on their own page type.
 */
export interface PolledPage {
  items: unknown[];
  /**
   * Serialized cursor for the next page, or null when this phase has no further pages.
   * Always a string — this is exactly the value persisted into channel_poll_state.cursor
   * during backfill, and exactly the value handed back to fetchPage on the next iteration
   * (or next run, after a deadline interruption); the adapter owns (de)serialization.
   */
  nextCursor: string | null;
  rateLimited: boolean;
  /**
   * Watermark candidate: the newest source id visible on this page, when the API reports one
   * (X's meta.newest_id). Results are newest-first, so the module keeps the FIRST page's value
   * for the whole round. Only consulted when useSinceIdWatermark is set.
   */
  newestId?: string;
}

export type PollPhase = "backfill" | "incremental";

export interface FetchPageArgs {
  /** Cursor to resume from, or null for the first page of this phase. */
  cursor: string | null;
  phase: PollPhase;
  /**
   * Stored since_id watermark — non-null only during incremental polling of a
   * useSinceIdWatermark poller (backfill must walk the full history unfiltered).
   */
  sinceId: string | null;
}

export interface PagedPollConfig<P extends PolledPage> {
  linkDb: D1Database;
  channelId: string;
  /** channel_poll_state.poller_name — literal ('posts', 'content') or computed ('list_posts:<id>'). */
  pollerName: string;
  /** Absolute epoch-ms budget boundary; checked before every page fetch in paged mode. */
  deadline: number;
  /**
   * "paged": multi-page loop on both phases with per-page cursor persistence (x-posts,
   * tiktok-content). "latest-page": exactly one page per run on both phases — the first run
   * seeds from the latest page and immediately marks backfill_complete (ignoring nextCursor:
   * a historical crawl would keep the trigger dark for hours), every later run fetches the
   * single latest page and relies on upsertPage's dedup to find what's new (x-list-posts).
   */
  mode: "paged" | "latest-page";
  /** Enables the since_id watermark contract described in the module comment (x-posts only). */
  useSinceIdWatermark?: boolean;
  /** Log event prefix, e.g. "posts_poll" -> "posts_poll_started". Names are load-bearing for prod debugging. */
  logPrefix: string;
  /** Extra fields spread into every log line right after channel_id (e.g. { list_id }). */
  logContext?: Record<string, unknown>;
  /** Fetch one page. Thrown errors escape unchanged (token refresh / freeze breaker upstream). */
  fetchPage(args: FetchPageArgs): Promise<P>;
  /**
   * Persist/emit one page's items; returns how many were NEW (drives the incremental
   * no_new_content stop). emitFlowEvent is false during backfill/seed, true during incremental.
   */
  upsertPage(page: P, emitFlowEvent: boolean): Promise<number>;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
  since_id: string | null;
}

export async function runPagedPoll<P extends PolledPage>(cfg: PagedPollConfig<P>): Promise<void> {
  const state = await cfg.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at, since_id FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(cfg.channelId, cfg.pollerName)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    log(cfg, "skipped_not_seeded", {});
    return;
  }

  const phase: string = state.backfill_complete ? "incremental" : cfg.mode === "latest-page" ? "seed" : "backfill";
  // latest-page pollers never had a cursor in their started line — keep both shapes stable.
  log(cfg, "started", cfg.mode === "paged" ? { phase, cursor: state.cursor } : { phase });

  if (!state.backfill_complete) {
    if (cfg.mode === "latest-page") {
      await seedFromLatestPage(cfg);
    } else {
      await runBackfill(cfg, state.cursor);
    }
  } else if (cfg.mode === "latest-page") {
    await runLatestPageIncremental(cfg);
  } else {
    await runPagedIncremental(cfg, state.since_id);
  }
}

async function runBackfill<P extends PolledPage>(cfg: PagedPollConfig<P>, startCursor: string | null): Promise<void> {
  let cursor = startCursor;
  let pagesFetched = 0;

  while (Date.now() < cfg.deadline) {
    const page = await cfg.fetchPage({ cursor, phase: "backfill", sinceId: null });
    if (page.rateLimited) {
      log(cfg, "rate_limited", { phase: "backfill", pagesFetched });
      return;
    }

    pagesFetched++;
    await cfg.upsertPage(page, false);

    if (page.nextCursor === null) {
      await markBackfillComplete(cfg);
      log(cfg, "backfill_complete", { pagesFetched });
      return;
    }

    // Persist every page boundary so a deadline kill resumes here instead of restarting.
    cursor = page.nextCursor;
    await cfg.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
      .bind(cursor, cfg.channelId, cfg.pollerName)
      .run();
  }

  log(cfg, "deadline_reached", { phase: "backfill", pagesFetched });
}

async function runPagedIncremental<P extends PolledPage>(cfg: PagedPollConfig<P>, sinceId: string | null): Promise<void> {
  let cursor: string | null = null;
  let pagesFetched = 0;
  let totalNew = 0;
  let newestId: string | undefined;
  let stopReason: "rate_limited" | "no_new_content" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < cfg.deadline) {
    const page = await cfg.fetchPage({ cursor, phase: "incremental", sinceId: cfg.useSinceIdWatermark ? sinceId : null });
    if (page.rateLimited) { stopReason = "rate_limited"; break; }

    // 结果倒序，第一页的 newest_id 就是本轮最新的一条 —— 只记第一次拿到的那个。
    if (newestId === undefined && page.newestId) newestId = page.newestId;

    pagesFetched++;
    const newCount = await cfg.upsertPage(page, true);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_content"; break; }
    if (page.nextCursor === null) { stopReason = "no_next_page"; break; }
    cursor = page.nextCursor;
  }

  // THE watermark invariant (see module comment): advance only when every new page was
  // consumed this round. Deadline / rate-limit stops still owe older new items — advancing
  // would skip them forever. Empty rounds (no newestId) keep the old watermark, never null it.
  const advanceWatermark =
    cfg.useSinceIdWatermark === true && newestId !== undefined && (stopReason === "no_new_content" || stopReason === "no_next_page");

  log(
    cfg,
    "incremental_complete",
    cfg.useSinceIdWatermark
      ? { pagesFetched, totalNew, stopReason, since_id: sinceId, new_since_id: advanceWatermark ? newestId : null }
      : { pagesFetched, totalNew, stopReason }
  );

  if (advanceWatermark) {
    await cfg.linkDb
      .prepare("UPDATE channel_poll_state SET since_id = ?, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
      .bind(newestId, cfg.channelId, cfg.pollerName)
      .run();
    return;
  }

  await touchLastPolledAt(cfg);
}

async function seedFromLatestPage<P extends PolledPage>(cfg: PagedPollConfig<P>): Promise<void> {
  // One page, no pagination, no deadline pre-check: latest-page triggers exist to react to
  // NEW content going forward, and leaving backfill_complete unset on rate-limit lets the
  // next cron cycle retry the seed.
  const page = await cfg.fetchPage({ cursor: null, phase: "backfill", sinceId: null });
  if (page.rateLimited) {
    log(cfg, "rate_limited", { phase: "seed" });
    return;
  }

  await cfg.upsertPage(page, false);
  await markBackfillComplete(cfg);
  log(cfg, "seed_complete", { fetched: page.items.length });
}

async function runLatestPageIncremental<P extends PolledPage>(cfg: PagedPollConfig<P>): Promise<void> {
  const page = await cfg.fetchPage({ cursor: null, phase: "incremental", sinceId: null });
  if (page.rateLimited) {
    // No last_polled_at touch: a rate-limited cycle did no work, and stamping it would delay
    // the next attempt by a full throttle interval.
    log(cfg, "rate_limited", { phase: "incremental" });
    return;
  }

  const newCount = await cfg.upsertPage(page, true);
  log(cfg, "incremental_complete", { fetched: page.items.length, newCount });
  await touchLastPolledAt(cfg);
}

async function markBackfillComplete<P extends PolledPage>(cfg: PagedPollConfig<P>): Promise<void> {
  await cfg.linkDb
    .prepare(
      "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?"
    )
    .bind(cfg.channelId, cfg.pollerName)
    .run();
}

async function touchLastPolledAt<P extends PolledPage>(cfg: PagedPollConfig<P>): Promise<void> {
  await cfg.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = ?")
    .bind(cfg.channelId, cfg.pollerName)
    .run();
}

function log<P extends PolledPage>(cfg: PagedPollConfig<P>, suffix: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `${cfg.logPrefix}_${suffix}`, channel_id: cfg.channelId, ...cfg.logContext, ...fields }));
}
