# X List Posts Trigger Design

## Context

[Content-Triggered Flow Design](2026-07-14-content-flow-triggers-design.md) explicitly deferred "see someone else's post → repost it": the generic `contentTrigger` node only fires on the tenant's own connected-channel content (own X posts, own TikTok videos). This design closes that gap for X specifically, using [X's List Tweets API](https://docs.x.com/x-api/lists/get-list-posts): a tenant picks one of their owned X Lists ([get-owned-lists](https://docs.x.com/x-api/users/get-owned-lists)), and a flow can now trigger on posts from *other* accounts that appear in that list — e.g. "repost anything my competitors list posts" or "AI-rewrite anything my curated-influencers list posts, to TikTok."

List Tweets has no webhook/streaming equivalent available to this app's access tier — it must be polled and diffed, like the existing X/TikTok content pollers.

## Scope

- Replace the generic `contentTrigger` flow node with per-platform trigger nodes, starting with `xContentTrigger` (a `tiktokContentTrigger` is expected to follow later, out of scope here — this design should leave that extension obvious, not build it).
- `xContentTrigger` supports two modes: **My Posts** (today's existing own-content behavior, carried over from `contentTrigger`) and **List Posts** (new).
- List selection is **per flow node**, not per channel binding: the underlying X channel is connected once (OAuth, as today); each `xContentTrigger` node in "List Posts" mode picks exactly one of that channel's owned Lists to watch. Different flows/nodes may watch different Lists off the same connected account.
- Dedup must be correct per list: if the same tweet appears in two different monitored Lists, each list's flow fires independently. Re-polling the same list and seeing the same tweet again must never refire.
- No migration path for existing `contentTrigger` flows — dev-only, clean cutover, node type is retired.

## Out of scope

- `tiktokContentTrigger` and any other platform's list/collection-style trigger (this design's node/schema choices should make that a small follow-on, not a redesign).
- Real-time/streaming ingestion (X's filtered stream requires a higher API tier than this app has — polling is the only option here).
- Any change to `xTrigger`, `cronTrigger`, or the existing "My Posts" content pipeline's behavior — it keeps working exactly as it does today.

## 1. Node & UI: `xContentTrigger`

Retires the generic `contentTrigger` node entirely — no dual-support period, no data migration (per the "clean cutover" decision; any dev flows using `contentTrigger` today are recreated by hand).

`data` shape:

```ts
{
  channelId: string;               // which connected X channel's token to use
  mode: "my_posts" | "list_posts";
  listId?: string;                 // required when mode === "list_posts"
  listName?: string;               // cached label for display only, refreshed on open
  conditions: Condition[];         // unchanged — existing generic ConditionsEditor
}
```

- **Canvas node** (`flow/frontend/nodes/XContentTriggerNode.tsx`, replacing `ContentTriggerNode.tsx`): shows mode + (if List Posts) the cached list name, plus existing condition-count summary.
- **Inspector** (`flow/frontend/components/Inspector.tsx`, replacing `ContentTriggerInspector`):
  1. Channel dropdown — the tenant's connected X channels only (real, user-bound `channel_type = 'x'` rows).
  2. Mode toggle: My Posts / List Posts.
  3. If List Posts: a List dropdown, populated by calling a new `link` endpoint (`GET /api/x/channels/:channelId/lists`) that proxies `get-owned-lists` with the selected channel's token. Called once when the Inspector opens or the channel changes, not on every keystroke/render.
  4. Existing generic `ConditionsEditor` over `CONTENT_TRIGGER_FIELDS`, unchanged, applied as an additional filter on top of the channel/list scoping.
- **Sidebar / templates / store**: `Sidebar.tsx`, `config/templates.ts`, `store/flow-editor.ts` all get `contentTrigger` → `xContentTrigger` renamed at every reference (default `data` includes `mode: "my_posts"` so a freshly-dropped node behaves like today's default with no extra clicks).
- **Domain routing** (`flow/src/index.ts`'s `GET /api/flows` domain filter, currently `graph_json LIKE '%contentTrigger%'`): string updated to `%xContentTrigger%` (and, when added later, any other `*ContentTrigger` node also counts toward the "content" domain).

## 2. `link`: List Posts polling and per-list dedup

New poller `link/src/services/pollers/x-list-posts.ts`, structurally parallel to `x-posts.ts`: calls `GET /2/lists/:id/tweets` via a new `fetchListPostsPage` in `link/src/services/x-posts-api.ts` (or a sibling file), authenticated with the parent channel's token through the existing `XTokenService` — `list.read` is already in `X_CHANNEL_SCOPES`, no OAuth app config change needed. Reuses `ContentMetadata_X`-style declarative field mapping (a new `sourceContentType: "get-list-posts"` entry, same shape as the existing `"get-posts"` entry, since the tweet object shape is the same as the user-tweets endpoint).

Ingestion still goes through `ContentService.upsertContentFromMetadata` — this is the schema change that makes per-list dedup work:

- **New nullable column**: `content.list_id`. Set only for content ingested via List Posts polling; `NULL` for every other poller (own posts, TikTok, manual sync, Notion sync — all unchanged).
- **Dedup index change**: replace the current unconditional `idx_content_channel_source` with two partial indexes:
  ```sql
  CREATE UNIQUE INDEX idx_content_channel_source
    ON content(channel_id, source_content_id) WHERE list_id IS NULL;
  CREATE UNIQUE INDEX idx_content_channel_list_source
    ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL;
  ```
  Every existing poller keeps writing rows with `list_id IS NULL`, so the first index preserves today's dedup behavior byte-for-byte. List-sourced content gets its own row per `(channel, list, tweet)` — the same tweet discovered via two different lists is two distinct rows, each independently gated by its own `isNew` check on insert. Re-polling the same list and re-seeing the same tweet still hits `ON CONFLICT` on the second index and does not refire `content.created` — this is the direct mechanism that answers "how do we avoid the same post retriggering."
- **Cursor/backfill state — no schema change**: reuses the existing `channel_poll_state` table (PK `(channel_id, poller_name)`) via a naming convention, `poller_name = "list_posts:{listId}"`. Each watched list gets its own cursor + `backfill_complete` row for free. A newly-watched list's first poll runs through the existing backfill-gated path in `upsertContentFromMetadata` (ingests, does not emit `content.created`), exactly like every other poller today — no new backfill logic needed.
- List Tweets has no `since_id` parameter (unlike the user-tweets timeline endpoint), so each poll cycle fetches the latest page (`max_results` default) and lets the dedup index determine what's actually new. If a list receives more new posts than one page within a single poll interval, the oldest of that batch could be missed — acceptable for v1 given the existing hourly cron cadence; flagged here rather than silently accepted.

**Tenant DB migration:** `content` lives in the per-tenant sharded DB, provisioned via `admin/src/services/tenant-init-sql.ts`'s `TENANT_DB_INIT_SQL` (idempotent `CREATE TABLE/INDEX IF NOT EXISTS`, run once per tenant at provisioning time). This is the first schema change to an already-provisioned tenant table since the per-tenant sharding model was introduced, and there's no existing `ALTER TABLE` rollout mechanism for already-created tenant DBs in this codebase. **Decision: no rollout mechanism needed.** There are no real customers yet — update `TENANT_DB_INIT_SQL` directly (new column + the two partial indexes replacing the old unconditional one) and drop/reprovision existing dev tenant DBs from scratch rather than building a migration runner. The implementation plan should note this as a one-time dev-data reset, not attempt a general-purpose existing-tenant migration tool.

## 3. Cross-service wiring + engine matching

- **New `flow` endpoint**: `GET /internal/list-watches` — scans published flows' `graph_json` for `xContentTrigger` nodes with `mode === "list_posts"`, returns distinct `{ channelId, listId }` pairs. `graph_json` (in `FLOW_DB`) is the sole source of truth; nothing new is persisted for this.
- **`link`'s cron** (`link/src/cron.ts`): before its normal per-channel loop, calls `list-watches` and folds each returned pair into the cycle — reusing the pair's channel's existing token and its `list_posts:{listId}` poll-state row. A pair that stops being returned (flow unpublished, node removed, node switched back to My Posts) simply stops being polled next cycle; there's no persisted registration on the `link` side to explicitly tear down.
- **`content.created` event payload** gains `listId` alongside the existing `channelId`/`contentId`/`payload` fields (present only for list-sourced content; absent/undefined otherwise) — this is how `flow`'s engine, which has no direct visibility into `link`'s data, learns which list a given piece of content came from.
- **Engine matching** (`flow/src/engine.ts`'s trigger-node filter): today's generic `contentTrigger` never filtered by source at all — any content-domain event was evaluated against any content-flow's conditions. `xContentTrigger` nodes need an added, non-optional filter clause *before* the user's conditions are evaluated:
  - My Posts mode: event's `channelId` must equal `node.data.channelId`.
  - List Posts mode: event's `channelId` must equal `node.data.channelId` **and** event's `listId` must equal `node.data.listId`.

  This is new required logic, not a rename of existing behavior — without it, a List Posts node would fire on unrelated content from any other channel/list in the tenant.

## Testing

- `link`: unit tests for the new poller/API client (mirroring `x-posts.ts` test coverage) and for `upsertContentFromMetadata`'s dedup behavior under the new partial-index scheme — specifically: (a) same tweet, same list, polled twice → second insert does not emit `content.created`; (b) same tweet, two different lists → both inserts succeed and both emit; (c) existing non-list content dedup (My Posts, TikTok) is unaffected — regression coverage.
- `flow`: unit tests for the engine's new channel/list filter clause on `xContentTrigger` (event matches only the node's configured channel+list; a same-tenant event from a different channel or list does not match). Unit test for `GET /internal/list-watches`'s graph_json scan (finds `list_posts` mode nodes, ignores `my_posts` mode nodes and non-`xContentTrigger` nodes, dedupes repeated pairs across multiple flows).
- Manual/dev verification: connect an X channel, create an `xContentTrigger` flow in List Posts mode against a real owned List containing at least one other account's recent post, confirm the flow fires once per genuinely-new list post and does not refire on subsequent poll cycles for already-seen posts.

## Non-goals

- `tiktokContentTrigger` or any other platform's equivalent (structurally enabled by this design's node/schema shape, not built here).
- Any UI for creating/editing X Lists themselves — only reading the tenant's already-existing owned Lists via `get-owned-lists`.
- Solving the tenant-DB existing-shard migration rollout mechanism in general — only flagging that this design's schema change is the first to need it.
