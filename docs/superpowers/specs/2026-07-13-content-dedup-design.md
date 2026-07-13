# Content R2 Data Catalog Dedup Design

## Context

`uniscrm.content`'s R2 Data Catalog table has accumulated duplicates the same way `uniscrm.user` did before ([ADR 0002](../../adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md)): dev's D1 `content` table has 40 rows, but Content Analysis reports against `uniscrm.content` show 367. Root cause, confirmed by reading the code:

- `link/src/services/content.ts`'s `upsertContentFromMetadata` unconditionally calls `this.pipelineContent.send([record])` on every upsert, with no "did anything actually change" gate — unlike the already-fixed `x-users.ts`.
- `link/src/services/pollers/x-posts.ts`'s `runIncrementalPoll` re-walks from the newest page on every cron tick, re-upserting (and thus re-sending) already-seen posts until it hits a page where every item is unchanged.
- R2 Pipelines sinks are append-only and R2 SQL is read-only, so every resend becomes a new duplicate row rather than an update.

Unlike `id` generation in the old `x-users.ts` bug, `content.ts`'s id handling is already correct (`isNew ? crypto.randomUUID() : existing[0].id`) — only the missing change-detection gate needs fixing.

dev's `PIPELINE_CONTENT` binding (`link/wrangler.toml`) is still on the old append-only stream/sink (`uniscrm_content_dev` / `content_sink_dev`), never recreated the way `PIPELINE_USER` was. Production has no `PIPELINE_CONTENT` binding at all — same as production's `PIPELINE_USER`, which remains an explicitly separate, not-yet-authorized task.

## Scope

1. **Source-side fix**: gate `upsertContentFromMetadata`'s pipeline send on an `unchanged` check, mirroring `x-users.ts`'s `upsertUserFromMetadata` pattern exactly — compare each dynamic column's resolved value against the existing row's stored value; skip the `pipelineContent.send()` call when nothing changed.
2. **Recreate dev's content R2 pipeline from scratch**: delete the old `uniscrm_content_dev` stream, `content_sink_dev` sink, and the `uniscrm_content_pipeline_dev` pipeline; drop the stale `uniscrm.content` Iceberg table via the REST Catalog API (`DELETE .../namespaces/uniscrm/tables/content?purge=true`); create a new stream + R2-Data-Catalog sink + pipeline, mirroring the pattern already used for `uniscrm.user`. dev's existing 367 rows are disposable — no migration.
3. **Add `analytics/pipelines/content-stream-schema.json`**: didn't exist before (content's pipeline was created ad hoc); bring it in line with `user-stream-schema.json`/`event-stream-schema.json` for documentation/reproducibility. Fields: `tenant_id` (int32), `id`, `channel_id`, `channel_type`, `source_content_id` (all required strings except `channel_type` which stays optional to match the D1 column), plus the `isInsight` `CONTENT_COLUMN_MAP` columns (`content_type`, `source_created_at`, `bookmark_count`, `impression_count`, `like_count`, `quote_count`, `reply_count`, `repost_count` as appropriate types — `content_text`/`title` are NOT included, matching `isInsight: false` on those props and the existing user-stream-schema precedent of only including `isInsight` fields).
4. **Extend the compactor to `uniscrm.content`**: add a `compactContentTable(env)` function in `analytics/src/index.ts`, calling the existing generic `/compact` endpoint on `CompactorContainer` with `table: "content"`, `key_columns: ["tenant_id", "channel_id", "source_content_id"]` — no changes needed to `analytics/compactor/main.py`, which already accepts these as request parameters.
5. **Fix `scheduled()`'s ordering**: currently the dashboard-report-recompute loop enqueues reports to `ANALYTICS_QUEUE` *before* `compactUserTable`/`compactContentTable` run, but the queue consumer processes independently/asynchronously — so today there's no guarantee a dashboard report's daily auto-recompute actually reads post-compaction data. Reorder `scheduled()` to run both compaction calls first (awaited, so they fully complete) and only then enqueue the dashboard-report recomputes, guaranteeing each day's automatic analytics reads freshly-deduped R2 tables.
6. **Production**: no `PIPELINE_CONTENT` infrastructure exists; explicitly out of scope for this work, same treatment as the still-deferred production `PIPELINE_USER` provisioning task.

## Testing

Per this repo's coding-agent workflow: add/review test cases for `upsertContentFromMetadata`'s new `unchanged` gate (in `link/tests/services/content.test.ts`, which already exists per the repo listing) and for the reordered `scheduled()` logic if testable in isolation. Manually verify in dev: confirm a Content Analysis report's count matches D1's `content` row count after the pipeline is recreated and at least one poll cycle + compaction run has occurred.

## Verification

1. `wrangler pipelines`/REST Catalog calls confirm the old content stream/sink/table are gone and new ones exist, matching the `uniscrm.user` pattern.
2. `content.ts`'s unit tests cover: unchanged content skips the pipeline send; changed content still sends; a brand-new content row sends.
3. After a posts-poller cycle and a compaction run, a fresh Content Analysis report's count is close to D1's `content` table count for the same tenant (not exactly equal, since new content between the poll and the report query is expected — the fix's target is "no runaway duplication," not byte-for-byte parity at every instant).
4. `scheduled()`'s dashboard-recompute enqueue loop only runs after both `compactUserTable` and `compactContentTable` have resolved (visible in code order + confirmed by dev cron logs showing compaction log lines before the first `report_id` enqueue log line on the same run).
