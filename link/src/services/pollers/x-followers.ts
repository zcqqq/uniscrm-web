import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { XUsersService } from "../x-users";
import { fetchFollowersPage } from "../x-followers-api";
import { resolveUserProps } from "./resolve-user-props";
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

  if (!state || Object.keys(state).length === 0) return; // not seeded yet — channel isn't authorized

  const usersService = new XUsersService(ctx.tenantDb, { pipelineUser: ctx.pipelineUser, tenantId: ctx.tenantId });

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
    const props = resolveUserProps(item, FOLLOWERS_METADATA.userProps, FOLLOWERS_METADATA.linkPrefix);
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

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) return;

    await upsertPage(usersService, page.data, ctx.channelId);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'"
        )
        .bind(ctx.channelId)
        .run();
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
      .bind(cursor, ctx.channelId)
      .run();
  }
}

async function runIncrementalPoll(ctx: FollowersPollerContext, usersService: XUsersService): Promise<void> {
  let cursor: string | undefined;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) break;

    const newCount = await upsertPage(usersService, page.data, ctx.channelId);

    if (newCount === 0 || !page.nextToken) break;
    cursor = page.nextToken;
  }

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
    .bind(ctx.channelId)
    .run();
}
