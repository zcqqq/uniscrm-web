# X BYOK Posts Polling Design

## Context

`link` already polls X BYOK channels for followers (`x-followers` poller, see `docs/superpowers/specs/2026-07-11-x-byok-followers-polling-design.md`). This extends the same mechanism to posts: on BYOK channel authorization, backfill the account's own tweets via `GET /2/users/:id/tweets` (`get-posts`), then poll hourly for new ones, writing to the tenant `content` table.

Scoped to BYOK only, same reasoning as the followers poller: shared-quota system-default app can't sustain per-tenant polling.

## Request shape

`GET https://api.x.com/2/users/:id/tweets`
- `exclude=replies,retweets`
- `max_results=100` (endpoint's page-size ceiling, unlike followers' 1000)
- `tweet.fields=<all documented fields>`: `id,text,author_id,created_at,conversation_id,edit_controls,edit_history_tweet_ids,entities,geo,in_reply_to_user_id,lang,non_public_metrics,note_tweet,organic_metrics,possibly_sensitive,promoted_metrics,public_metrics,referenced_tweets,reply_settings,scopes,source,withheld`
- No `expansions` param. `expansions` only populates a separate top-level `includes` object (media/polls/referenced tweets), which we're not merging into `raw_data` (decided below) — requesting it would be wasted API weight.
- `author_id` on every returned tweet always equals the channel's own `x_user_id` (this is the account's own timeline) — no cross-referencing against the `user` table is needed for this poller.

Some fields (`non_public_metrics`, `organic_metrics`, `promoted_metrics`) need elevated app access; same tolerance as the followers poller — request the full set, observe whether X 400s the request, don't special-case it upfront.

## `content` table changes

Current schema lacks `channel_id` (only `channel_type`), has no column matching `content_text`/`content_type`, and `title` is `NOT NULL` (tweets have no title). SQLite can't `ALTER COLUMN` to drop `NOT NULL`, so this is a table rebuild, not a plain `ALTER TABLE`.

`content`/`user` live in **per-tenant** D1 databases (provisioned once via `admin/src/services/tenant-init-sql.ts`, no migration runner) — not in `LINK_DB`, so this is not a `link/migrations/*.sql` file (that directory only applies to `LINK_DB`: `channels`, `channel_poll_state`, etc.). This is a one-off SQL script run directly against each tenant DB via `wrangler d1 execute --file`, same as the earlier `user`-table column additions:

```sql
ALTER TABLE content RENAME TO content_old;

CREATE TABLE content (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  channel_type TEXT NOT NULL,
  content_type TEXT,
  source_content_id TEXT NOT NULL,
  title TEXT,
  content_text TEXT,
  summary TEXT,
  status TEXT DEFAULT 'new',
  source_url TEXT,
  source_updated_at TEXT,
  source_created_at TEXT,
  raw_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO content (id, channel_type, source_content_id, title, summary, status, source_url, source_updated_at, raw_data, created_at, updated_at)
SELECT id, channel_type, source_content_id, title, summary, status, source_url, source_updated_at, raw_data, created_at, updated_at FROM content_old;

DROP TABLE content_old;

CREATE UNIQUE INDEX idx_content_channel_source ON content(channel_id, source_content_id);
CREATE INDEX idx_content_status ON content(status);
```

Existing rows (all webhook/system-app sourced, pre-dating `channel_id`) get `channel_id = NULL`. SQLite treats each `NULL` as distinct in a unique index, so old rows don't collide with each other or with new poller-written rows under the new `(channel_id, source_content_id)` index — no backfill of `channel_id` for old rows is needed for correctness.

`admin/src/services/tenant-init-sql.ts`'s `content` `CREATE TABLE` gets updated to this same shape for future tenants, and its unique index changes from `(channel_type, source_content_id)` to `(channel_id, source_content_id)`.

**Rollout to existing tenant DBs**: run this migration against `uniscrm-t1-dev` and (after dev verification) production `uniscrm-t1`, same as the earlier `user` table column additions. Because this is a table rebuild rather than an additive `ALTER TABLE`, take a `wrangler d1 export` backup of the `content` table immediately before running it on either DB.

## Column mapping (propId → column)

Per the established convention (userProps-mapped fields get a real column; everything else stays `raw_data`-only), but unlike the `user` table's 1:1 name match, `content` needs an explicit map since a couple of propIds don't match their column name:

```ts
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  contentText: "content_text",
  posted_at: "source_created_at",
};
```

`metadata/x-byok.ts`'s `ContentMetadata_X` (already updated by the user) stays as-is:

```ts
export const ContentMetadata_X: ContentMetadata[] = [
  {
    sourceContentType: "get-posts", // https://docs.x.com/x-api/users/get-posts author_id=source_channel_id
    linkPrefix: "data[]",
    contentProps: [
      { propId: "content_type", value: "TWEET" },
      { propId: "posted_at", dataId: "{linkPrefix}.created_at" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "contentText", dataId: "{linkPrefix}.text" },
    ],
  },
];
```

`PROPS_X` in `metadata/x.ts` gets three new entries: `content_type` (TEXT), `contentText` (TEXT), reusing existing `posted_at` (already defined, DATETIME). No collision with existing propIds — dedup is handled manually per prop, per the user's explicit call (no automated namespacing mechanism).

`raw_data` = `JSON.stringify(rawItem)`, the whole `data[]` entry unfiltered — same convention as the followers poller and `event.raw_data`. `includes` is discarded, not merged in.

## `ContentService.upsertContentFromMetadata`

New method alongside the existing `syncBatch` (untouched — that's the webhook/manual-sync path; this is the poller path), mirroring `XUsersService.upsertUserFromMetadata`:

```ts
async upsertContentFromMetadata(
  rawItem: Record<string, unknown>,
  resolvedProps: Record<string, unknown>,
  channelId: string,
  channelType: ChannelType
): Promise<boolean> // returns isNew
```

- Resolves `sourceContentId` from `resolvedProps.source_content_id`.
- Atomic `INSERT ... ON CONFLICT(channel_id, source_content_id) DO UPDATE` (same TOCTOU-safe pattern as the user upsert — backfill and incremental polls could race).
- Column-mapped fields (`content_type`, `content_text`, `source_created_at`) written via `CONTENT_COLUMN_MAP`, same omit-if-unresolved rule as `USER_TABLE_COLUMNS`.
- `title`/`summary` are left `NULL` — not populated by this path (decided: no truncation of `text` into `title`).
- After the D1 write, calls the same embedding logic `ContentService` already uses in `syncBatch`/`update` (`embedContents`, currently private — becomes shared internally, called from both paths) so poller-sourced tweets get embedded into Vectorize for content recommendation, matching the existing webhook/manual-sync path.

No content pipeline/R2 stream exists today (`content` only reaches D1 + Vectorize, unlike `user`/`event` which also stream to R2 via Pipelines) — this poller does not add one; it only writes D1 + triggers the same embedding call already used elsewhere.

## Poller (`link/src/services/pollers/x-posts.ts`)

Same two-phase shape as `x-followers.ts` (`docs/superpowers/specs/2026-07-11-x-byok-followers-polling-design.md`), reusing:
- The same `channel_poll_state` table, new row `poller_name = 'posts'` (matching the existing bare `'followers'` naming, not `'x-followers'`/`'x-posts'`).
- The same poller registry (`POLLERS.X` gains a second entry: `[followersPoller, postsPoller]`).
- The same cron budget-sharing loop in `handlePolling` — no changes to `cron.ts`'s structure.
- The same page-size/rate-limit/429 handling pattern as `x-followers-api.ts`, in a new `x-posts-api.ts` (`fetchPostsPage`).

**Backfill** (`backfill_complete = 0`): page via `pagination_token` until no `next_token` → `backfill_complete = 1`, persisting `cursor` after every page.

**Incremental** (`backfill_complete = 1`): each hourly run starts at page 1 (newest-first); after a page, if it produced zero new tweets (every `source_content_id` in it already existed), stop; otherwise continue to the next page — identical stop condition to the followers poller's post-backfill phase.

`link/src/oauth.ts`'s BYOK-callback poll-state seeding extends from a single `poller_name = 'followers'` reset to loop over `['followers', 'posts']`.

## `buildEmbeddingText` fix

`ContentService.buildEmbeddingText` currently does `parts = [item.title]`, unconditionally leading with `title`. Tweet-sourced content has `title = NULL`, so embedding text would start empty/broken and never include the tweet's actual text (`content_text` isn't read at all today). Fix: `parts = [item.title || item.content_text]` — falls back to `content_text` when `title` is unset, no change for existing non-tweet content (which always has `title`).

## Opportunistic fixes bundled in

- `link/src/services/pollers/resolve-user-props.ts` imports `UserPropMapping` from `metadata/dataTypes.ts`, which doesn't exist there (only `PropMapping` is defined; `metadata/index.ts` re-exports a non-existent `UserPropMapping`/`EventPropMapping` from `dataTypes.ts` too — a latent broken re-export, currently unused so it doesn't surface as a build error). Since this design reuses that resolver for `contentProps` (also typed `PropMapping[]`), fix the import to the real `PropMapping` type and rename the file/function to the neutral `resolveProps` (it already has no user-specific logic) rather than adding a second near-duplicate resolver. Fix `metadata/index.ts`'s re-export line to only export what actually exists.

## content-count limit removal

`link/src/routes-contents.ts`'s content-sync route enforces a 100-rows-per-tenant cap via `LimitService`, requiring an explicit `confirmed=true` to evict oldest rows — a UI-confirmation gate that has no cron equivalent. Per explicit decision: remove this cap for `content` entirely (both the poller path and the existing manual-sync route), rather than auto-evicting silently from a cron job. `ProductLimitService`'s separate 100-item cap on `products` is untouched — only the `content`-specific enforcement in `routes-contents.ts` is removed.

## Testing

- Unit tests for `resolveProps` (renamed) covering `contentProps` resolution (dataId navigation, static `value`, omission-on-missing) — largely already covered by the existing `resolveUserProps` tests, extend for content-shaped input.
- Unit tests for `ContentService.upsertContentFromMetadata`: insert/update/atomic-upsert semantics, column-mapped fields (`content_type`→`content_type`, `contentText`→`content_text`, `posted_at`→`source_created_at`) written correctly, unresolved fields omitted (not NULL-defaulted), embedding triggered.
- Unit tests for the posts poller: backfill cursor persistence across pages, 429 mid-backfill leaves `cursor` persisted without setting `backfill_complete`, post-backfill zero-new-tweets page stops the loop.
- Integration-style test (mocked X API) for `handlePolling`: BYOK channel now runs both `followers` and `posts` pollers; system-app X channel runs neither.
