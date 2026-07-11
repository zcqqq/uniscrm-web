import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { XUsersService } from "../x-users";
import { fetchFollowersPage } from "../x-followers-api";
import { resolveProps } from "./resolve-props";
import { UserMetadata_X } from "../../../../metadata/x-byok";

const FOLLOWERS_METADATA = UserMetadata_X.find((m) => m.sourceUserType === "get-followers")!;

export interface FollowersPollerContext {
  channelId: string;
  xUserId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  tenantId: number;
  pipelineUser?: Pipeline;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runFollowersPoller(ctx: FollowersPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'followers'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "followers_poll_skipped_not_seeded", channel_id: ctx.channelId }));
    return; // not seeded yet — channel isn't authorized
  }

  const usersService = new XUsersService(ctx.tenantDb, { pipelineUser: ctx.pipelineUser, tenantId: ctx.tenantId });
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "followers_poll_started", channel_id: ctx.channelId, phase, cursor: state.cursor }));

  if (!state.backfill_complete) {
    await runBackfill(ctx, usersService, state.cursor);
  } else {
    await runIncrementalPoll(ctx, usersService);
  }
}

async function upsertPage(
  usersService: XUsersService,
  items: Record<string, unknown>[],
  channelId: string
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, FOLLOWERS_METADATA.userProps, FOLLOWERS_METADATA.linkPrefix);
    const isNew = await usersService.upsertUserFromMetadata(item, props, channelId, "X");
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: FollowersPollerContext,
  usersService: XUsersService,
  startCursor: string | null
): Promise<void> {
  let cursor = startCursor || undefined;
  let pagesFetched = 0;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "followers_poll_rate_limited", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(usersService, page.data, ctx.channelId);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'"
        )
        .bind(ctx.channelId)
        .run();
      console.log(JSON.stringify({ event: "followers_poll_backfill_complete", channel_id: ctx.channelId, pagesFetched }));
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
      .bind(cursor, ctx.channelId)
      .run();
  }

  console.log(JSON.stringify({ event: "followers_poll_deadline_reached", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: FollowersPollerContext, usersService: XUsersService): Promise<void> {
  let cursor: string | undefined;
  let pagesFetched = 0;
  let totalNew = 0;
  let stopReason: "rate_limited" | "no_new_users" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) { stopReason = "rate_limited"; break; }

    pagesFetched++;
    const newCount = await upsertPage(usersService, page.data, ctx.channelId);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_users"; break; }
    if (!page.nextToken) { stopReason = "no_next_page"; break; }
    cursor = page.nextToken;
  }

  console.log(JSON.stringify({ event: "followers_poll_incremental_complete", channel_id: ctx.channelId, pagesFetched, totalNew, stopReason }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
    .bind(ctx.channelId)
    .run();
}
