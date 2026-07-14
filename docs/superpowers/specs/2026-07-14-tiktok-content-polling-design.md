# TikTok Content Polling Design

## Context

TikTok content sync today is ad-hoc: `TikTokChannel.fetchItems()` (hardcoded field mapping in `link/src/channels/tiktok.ts`) is called once synchronously in the OAuth callback and again on-demand via the manual `/tiktok/sync` button, writing through `ContentService.syncBatch()` — a generic diff/upsert path that predates the metadata-driven pipeline and never reaches the R2 Data Catalog/Content Analytics pipeline.

This design migrates TikTok content onto the same metadata-driven pipeline X posts already uses (`docs/superpowers/specs/2026-07-11-x-posts-polling-design.md`): `ContentMetadata` + `resolveProps` + `ContentService.upsertContentFromMetadata` + `channel_poll_state`-tracked hourly polling. Unlike X (BYOK-only, dual poller for followers+posts), TikTok is a single system-shared app (`env.TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`, no BYOK) with one poller (content only).

Along the way, this also generalizes the per-channel poll invocation into a single reusable function shared between the cron loop and both platforms' OAuth callbacks, and fixes a live regression: an earlier propId rename (`impression_count` → `view_count`) left `content.ts`'s `CONTENT_COLUMN_MAP` pointing at the old propId, so X's view-count writes have been silently dropping.

## Metadata changes

`metadata/props.ts`: add `"VIDEO"` to `content_type`'s enum (currently only `TWEET`/`ARTICLE`). The four TikTok-specific props (`cover_image_url`, `duration`, `height`, `width`) are already present, all tagged `entity: ["content"]`.

`metadata/tiktok.ts`: rename the copy-pasted `ContentMetadata_X` export to `ContentMetadata_TikTok` (it was never wired into `index.ts`, so this is a pure rename, no call sites to update). Wire it into `metadata/index.ts` alongside the existing `ContentMetadata_X` export.

## `content` table changes

Per-tenant D1, same rollout mechanism as prior `content` schema changes (one-off `wrangler d1 execute` against each tenant DB, dev first then prod under explicit confirmation — no migration runner exists for tenant DBs):

```sql
ALTER TABLE content RENAME COLUMN impression_count TO view_count;
ALTER TABLE content ADD COLUMN share_count INTEGER;
ALTER TABLE content ADD COLUMN cover_image_url TEXT;
ALTER TABLE content ADD COLUMN duration INTEGER;
ALTER TABLE content ADD COLUMN height INTEGER;
ALTER TABLE content ADD COLUMN width INTEGER;
```

The rename preserves the 40 rows of real X content data already written under `impression_count` (see the earlier posts-polling production fix) rather than orphaning them in a dead column.

`link/src/services/content.ts`'s `CONTENT_COLUMN_MAP` updates to match:

```ts
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  view_count: "view_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
  share_count: "share_count",
  cover_image_url: "cover_image_url",
  duration: "duration",
  height: "height",
  width: "width",
};
```

## TikTok API request shape

`POST https://open.tiktokapis.com/v2/video/list/`, body `{ max_count: 20, cursor }`, header `fields` query param:

```
id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count
```

TikTok's v2 API reports errors via a `body.error.code` field rather than relying purely on HTTP status. This design detects `access_token_invalid` (unauthorized, triggers the refresh-and-retry-once path) and `rate_limit_exceeded` (treated like X's 429 — stop the current poll cycle, resume next tick) by string-matching `body.error.code`. These exact code strings are a best-effort assumption from documented TikTok API behavior, not verified against live traffic in this session — flag and adjust during implementation testing if actual responses differ.

`comment_count` maps to the shared `reply_count` prop (same propId X's reply metric uses); `video_description` maps to `content_text`; `title` maps to `title` directly (TikTok returns both fields distinctly, unlike X where title only exists for Articles).

## New service files

**`link/src/services/tiktok-content-api.ts`** — `fetchVideoListPage(accessToken, cursor)`, mirroring `x-posts-api.ts`'s shape:

```ts
export interface TikTokVideoPage {
  data: Record<string, unknown>[];
  nextCursor?: number;
  hasMore: boolean;
}
export interface TikTokVideoFetchResult {
  page: TikTokVideoPage;
  rateLimited: boolean;
}
export async function fetchVideoListPage(accessToken: string, cursor?: number): Promise<TikTokVideoFetchResult>
```

Throws `TikTokUnauthorizedError` (new, in `link/src/services/tiktok-errors.ts`, mirroring `XUnauthorizedError`) on `access_token_invalid`.

**`link/src/services/tiktok-token.ts`** — `TikTokTokenService` class, mirroring `XTokenService`:

```ts
class TikTokTokenService {
  constructor(private db: D1Database) {}
  async refreshAccessToken(channelId: string): Promise<string>
  async getValidToken(channelId: string): Promise<string> // proactive refresh if expiring within 10 min
}
```

Replaces the inline refresh-token fetch currently duplicated in `cron.ts`'s `handleTokenRefresh` TikTok section — that section now calls `TikTokTokenService.refreshAccessToken` instead of hand-rolling the same `fetch()`.

**`link/src/services/pollers/tiktok-content.ts`** — `runTikTokContentPoller(ctx)`, structurally identical to `x-posts.ts`:

```ts
export interface TikTokContentPollerContext {
  channelId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  deadline: number;
}
export async function runTikTokContentPoller(ctx: TikTokContentPollerContext): Promise<void>
```

Reads `channel_poll_state` for `channel_id = ctx.channelId AND poller_name = 'content'`. Backfill phase pages via `cursor`/`has_more` until `has_more = false` → `backfill_complete = 1`. Incremental phase re-walks from the first page each tick, stopping when a page produces zero new videos (identical stop condition to `x-posts.ts`'s incremental phase) — same rationale: TikTok's `video.list` is also newest-first, no separate "since" parameter.

Each item resolves via `resolveProps(item, TIKTOK_METADATA.contentProps, TIKTOK_METADATA.linkPrefix)` then `contentService.upsertContentFromMetadata(item, props, channelId, "TIKTOK")`.

## Generic per-channel poll invocation

New `link/src/services/pollers/poll-channel.ts`:

```ts
export async function pollChannelOnce(env: Env, channelType: "X" | "TIKTOK", channelId: string): Promise<void>
```

- Loads the channel row (`config`, `tenant_id`) scoped to `channelType` and `channelId`.
- `X` branch: requires `config.is_byok` and `config.x_user_id` (unchanged gate from today's `handlePolling`); runs the existing `shouldPoll`-gated followers+posts logic (moved here verbatim from `cron.ts`'s loop body, including the 401-refresh-and-retry-once pattern) via `getAppCredentials`/`XTokenService`.
- `TIKTOK` branch: no BYOK gate (system app); runs `shouldPoll`-gated content poller via `TikTokTokenService`, same 401-refresh-and-retry-once shape.
- Both branches share the same tenant D1 lookup (`WEB_DB.tenants.d1_database_id` → `TenantDataDB`) and the same `shouldPoll(pollerName)` gating helper (`backfill_complete && last_polled_at` within `REPOLL_INTERVAL_MS` → skip), lifted out of `cron.ts` as a shared local helper.

`cron.ts`'s `handlePolling` becomes:

```ts
const rows = await env.LINK_DB
  .prepare("SELECT id, channel_type, config, tenant_id FROM channels WHERE channel_type IN ('X', 'TIKTOK') AND is_active = 1")
  .all<{ id: string; channel_type: "X" | "TIKTOK"; config: string; tenant_id: number | null }>();

for (const row of rows.results) {
  if (Date.now() >= runDeadline) break;
  await pollChannelOnce(env, row.channel_type, row.id);
}
```

`link/src/oauth.ts` changes:
- X BYOK callback: unchanged seeding of `channel_poll_state` for `['followers', 'posts']`, then add one call `await pollChannelOnce(env, "X", byokChannelId)` before redirecting — gives BYOK X users the same instant-results-on-connect experience TikTok already has, instead of waiting for the next cron tick.
- TikTok callback: seed `channel_poll_state` for `poller_name = 'content'` (same INSERT-or-reset-on-reauth pattern as X), replacing the current inline `TikTokChannel.fetchItems()` + `contentService.syncBatch()` block with `await pollChannelOnce(env, "TIKTOK", channelId)`.

Both callback sites wrap the `pollChannelOnce` call in try/catch, logging failure but not blocking the redirect — matches today's TikTok behavior (`console.error("TikTok content sync failed:", e)`), so a slow/failing first poll never breaks the OAuth flow itself.

`TikTokChannel`/`fetchItems` and the `/tiktok/sync` manual-sync route in `routes-channels.ts` are left as-is (out of scope) — they still use `syncBatch`, a separate/older path. Only the OAuth-callback-triggered sync is migrated in this design.

## Testing

- `link/tests/services/tiktok-content-api.test.ts`: page shape parsing, `rateLimited`/`TikTokUnauthorizedError` detection on the assumed error codes.
- `link/tests/services/tiktok-token.test.ts`: `getValidToken` proactive-refresh threshold, `refreshAccessToken` persists new tokens.
- `link/tests/services/pollers/tiktok-content.test.ts` (new `pollers/` subdirectory, since this is the first poller test needing its own file grouping distinct from the flat `x-posts.test.ts` naming): backfill cursor persistence, zero-new-videos stop condition, `channel_poll_state` transitions.
- `link/tests/services/pollers/poll-channel.test.ts`: X branch requires BYOK+`x_user_id`, TikTok branch has no such gate; both branches' `shouldPoll` skip-too-recent logic; 401-retry-once for each platform.
- Extend `link/tests/services/cron-polling.test.ts` (existing) for the `handlePolling` query now covering both channel types and delegating to `pollChannelOnce`.
- Extend `link/tests/oauth.test.ts` for both callbacks now calling `pollChannelOnce` and seeding poll state correctly.
