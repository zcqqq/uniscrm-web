# Content-Trigger No-D1-Write Design

**Goal:** Stop persisting a `content` D1 row for content ingested purely to trigger a flow (`flowType: "trigger"` sources), while keeping flow-triggering idempotent and without silently breaking other features.

**Why:** Per-tenant D1 storage is a limited, costed resource (`uniscrm-web/CLAUDE.md`: "调用外部API返回的payload全量数据不要存在数据库中，节约数据库存储空间"). Trigger-source content (a watched YouTube video, an X List post) exists only to decide "should this flow fire" — nothing downstream needs to read it back as a row after the flow has consumed it. Content the tenant itself owns or publishes (own X posts, own TikTok videos, flow-generated reposts) is a different case: it's browsed, analyzed, and status-tracked on purpose, so it keeps writing to D1 and to the `pipelineContent` R2/Iceberg analytics stream unchanged.

## Scope

Applies to **every** `ContentMetadata` entry with `flowType: "trigger"` (`metadata/dataTypes.ts:56`). Today that's exactly:
- `metadata/x-byok.ts`'s `get-list-posts` (X List Posts trigger), ingested by `link/src/services/pollers/x-list-posts.ts`.
- `metadata/youtube.ts`'s `watch:get-videos` (YouTube subscription trigger, being redesigned in the companion "YouTube Channel→Subscription" spec) — this spec adds `flowType: "trigger"` to that entry, since it was previously unset.

Untouched: `metadata/x-byok.ts`'s `own:get-posts` (own X post analytics, `link/src/services/pollers/x-posts.ts`) and `metadata/tiktok.ts`'s `video.list` (own TikTok video analytics, `link/src/services/pollers/tiktok-content.ts`) — neither has `flowType` set, both keep calling `ContentService.upsertContentFromMetadata` exactly as today (D1 write + `pipelineContent` R2 write). Also untouched: `ContentService.recordPublishedContent` (`link/src/services/content.ts:256`), used for content the flow itself publishes (e.g. `xContentAction` reposts) — that content is genuinely owned by the tenant and keeps its D1 row.

## Idempotency: why a dedup mechanism is required

`upsertContentFromMetadata`'s existing `isNew` check (`content.ts:162`, from a D1 `SELECT ... WHERE channel_id = ? AND source_content_id = ? [AND list_id = ?]`) is the only thing preventing a duplicate flow trigger when:
- WebSub redelivers the same YouTube push notification (PubSubHubbub retries on any non-2xx, and per spec may redeliver even on success).
- A poller's cron tick re-walks the same "latest page" it already saw (`x-list-posts.ts`'s `runIncrementalPoll` has no `since_id`, by design — it relies entirely on the dedup check to know what's new).

Removing the D1 write without replacing this check reproduces the "flow triggered 92 times, no repost" class of bug from earlier this session. The dedup key must include the same discriminators the current partial-unique-index scheme uses (`admin/src/services/tenant-init-sql.ts:82-83`: `(channel_id, source_content_id)` when there's no secondary dimension, `(channel_id, list_id, source_content_id)` when there is) — X List Posts intentionally fires once per list a tweet appears in, so a dedup key that drops the secondary dimension would collapse multi-list matches into one and silently under-fire.

## New table: `content_trigger_dedup`

Lives in the **tenant DB** (same D1 database as `content`, provisioned the same way — added to `admin/src/services/tenant-init-sql.ts` and picked up by the existing tenant-DB auto-apply-DDL runner, so it reaches existing tenants without a manual per-tenant step).

```sql
CREATE TABLE IF NOT EXISTS content_trigger_dedup (
  channel_id TEXT NOT NULL,
  secondary_id TEXT NOT NULL DEFAULT '',
  source_content_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, secondary_id, source_content_id)
)
```

- `secondary_id` holds the trigger's secondary discriminator as a plain string: X List Posts' `listId`, YouTube's `subscriptionChannelId`. `''` (empty string, not NULL) when a trigger type has no secondary dimension — this sidesteps the two-partial-index dance `content` needed only because SQL treats NULL as distinct-from-itself in a unique index; a `PRIMARY KEY` with a non-null `''` sentinel does not have that problem, so one table, one key, no partial indexes.
- No other columns — this table exists purely to answer "have I seen this before," never to answer "what was in it." `seen_at` is diagnostic only (not part of the key), useful for a future TTL cleanup job but not required by this spec.
- `tenant_id` is denormalized onto the row (the tenant DB is already tenant-scoped, so it's redundant for querying, but keeps the row self-describing in logs/exports without a join — same rationale as `channels.tenant_id` in `link`'s shared table).

## ContentService changes (`link/src/services/content.ts`)

Add a new method, replacing `upsertContentFromMetadata` for trigger-source callers:

```ts
async recordTriggerContentSeen(
  channelId: string,
  secondaryId: string,       // "" if the trigger type has no secondary dimension
  sourceContentId: string,
): Promise<boolean>          // true = genuinely new, caller should proceed to emit the flow event
```

Implementation: `INSERT OR IGNORE INTO content_trigger_dedup (channel_id, secondary_id, source_content_id, tenant_id, seen_at) VALUES (?, ?, ?, ?, ?)`, then check the D1 `meta.changes` (or equivalent) on the result — `changes === 1` means the row was newly inserted (new content), `changes === 0` means the primary key already existed (duplicate delivery, skip).

Callers (`x-list-posts.ts`'s `upsertPage`, and YouTube's ingestion path per the companion spec) change from:
```ts
const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X", emitFlowEvent, listId);
```
to:
```ts
// ALWAYS record — including during the seed phase (emitFlowEvent=false). The dedup table is
// now the only place "already seen" state lives; skipping the record during seed means the
// first incremental poll sees the whole seeded backlog as new and floods the flow (the
// 92-triggers bug, reincarnated). Only the flow-event emission is conditional on emitFlowEvent.
const isNew = await contentService.recordTriggerContentSeen(channelId, listId, sourceContentId);
if (isNew && emitFlowEvent) {
  await contentService.emitContentTriggerEvent(channelId, channelType, "listId", listId, resolvedProps);
}
```
`x-list-posts.ts`'s seed phase (`seedFromLatestPage`) currently uses the D1 write itself as the seeding mechanism — under the new design it must still call `recordTriggerContentSeen` during seeding; only the flow-event emission is skipped, not the dedup write. (YouTube has no seed phase — it's WebSub push, not polled — so this specific flood risk doesn't apply there; YouTube's dedup write only guards against WebSub redelivering the same notification.)

`emitContentTriggerEvent` carries forward the existing `flowQueue.send(...)` shape from `content.ts:241-250`, with two changes:
- `contentId` becomes a freshly generated `crypto.randomUUID()` (no longer a D1 row id — it's now purely an opaque per-delivery correlation id, used only by `flow`'s own `content_flow_executions`/`content_flow_pending` tables (`flow/migrations/0013_content_flow_tables.sql`), which live in `flow`'s own D1 and never join against the tenant DB's `content` table — verified via `flow/src/index.ts` grep, confirming this is safe).
- The secondary-dimension field name is now an **explicit parameter** (`secondaryFieldName: "listId" | "subscriptionChannelId"`), not inferred — X List Posts passes `"listId"`, YouTube passes `"subscriptionChannelId"` (per the companion spec). This method doesn't rename existing wire contracts, it only removes the D1/`pipelineContent` side effects; making the field name explicit avoids a plan-writer guessing and regressing the working X path.

**This is not sufficient by itself** — the companion YouTube spec's "flow queue consumer" section documents the corresponding change needed in `flow/src/index.ts`'s queue consumer (`~978-987`) and the `FlowQueueMessage` type, without which `subscriptionChannelId` is emitted but never reaches `engine.ts`'s match payload.

`upsertContentFromMetadata` itself is unchanged and keeps serving `x-posts.ts`, `tiktok-content.ts`, and any future own-content poller.

## `updateContentStatus` action: removed entirely

`updateContentStatus` (`flow/src/index.ts:434-440`) does `UPDATE content SET status = ? WHERE id = ?` using the triggering content's `contentId`. Once trigger-source content stops getting a `content` row, `contentId` for these flows is an opaque UUID that was never inserted — the UPDATE silently matches zero rows. Investigation found no other caller relies on this action (content the flow itself publishes goes through `recordPublishedContent`, a separate non-flow-action code path called directly from `link/src/routes-internal.ts`, not through this node type). Rather than leave a silently-broken action available to flow authors (violating this project's "数据准确性 > 系统稳定性 > 功能" priority), remove it:

- `flow/nodeTypeRegistry.ts`: delete the `updateContentStatus` entry from `NODE_TYPE_REGISTRY` and from the generatable-content-domain-actions list.
- `flow/src/engine.ts:268`: delete the `updateContentStatus` branch.
- `flow/src/index.ts:434-440`: delete the `updateContentStatus` execution branch.
- `flow/src/generate-prompt.ts`: remove `"updateContentStatus"` from the content-domain prompt's allowed `actionType` list (`generate-prompt.ts:64`).
- `flow/frontend/components/Inspector.tsx` and any node/sidebar component referencing `updateContentStatus`: remove.
- `flow/tests/unit/generate-prompt.test.ts` and any other test asserting `updateContentStatus` behavior: update/remove.

`ContentService.update()` (`content.ts:285`, the manual `PATCH /content/:id` CRUD endpoint used by a Content management UI, if any) is untouched — it operates on rows that do exist (own-content), and is unrelated to this flow-action node type.

## Out of scope

- No backfill/migration of existing `content_trigger_dedup`-equivalent state — dev data for the two affected trigger types (X List Posts, YouTube subscriptions) gets manually cleared as part of the companion YouTube spec's rollout; there's no prior dedup state to preserve.
- No TTL/cleanup job for `content_trigger_dedup` rows in this spec — the table only ever grows. Acceptable for v1 (each row is a handful of bytes); revisit if it becomes a real storage concern.
- `analytics` module's `uniscrm.content` dashboard (`analytics/src/index.ts:559,707`, fed by `pipelineContent`): **accepted regression, not unaffected.** `upsertContentFromMetadata` today sends every ingested item — trigger-source or not — to `pipelineContent` (`content.ts:217`, gated only on `this.pipelineContent && !unchanged`, not on content type). Once `x-list-posts.ts` and YouTube's ingestion switch to `recordTriggerContentSeen`/`emitContentTriggerEvent` (neither of which touches `pipelineContent`), X List Posts tweets and YouTube subscription videos stop appearing in `uniscrm.content` going forward. Own X posts, own TikTok videos, and flow-published content (`recordPublishedContent`) are unaffected and keep flowing into analytics exactly as today. This matches the explicit scope decision (flowType=trigger writes neither D1 nor R2; own-content writes both).
