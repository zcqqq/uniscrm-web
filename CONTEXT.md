# uniscrm-web

Multi-tenant Social CRM SaaS. Channels (X, TikTok, Notion, Shopify, ...) feed a shared `user`/`content`/`event` model per tenant, driven by declarative metadata under `/metadata/`.

## Language

**Prop / PropDefinition**:
A single field in the metadata registry (`metadata/x.ts` etc.), identified by a unique `propId` — the primary key of the registry. Downstream code (D1 columns, UI dropdowns, R2 sync) looks props up by `propId`, so it must never collide within a channel's registry and must be spelled identically everywhere it's referenced (metadata mapping, column-map, UI).
_Avoid_: field, attribute (too generic — use Prop only for entries in the metadata registry).

**PropMapping**:
An entry inside `UserMetadata`/`ContentMetadata`/`EventMetadata` that resolves one `propId` from a raw channel payload — either a fixed `value` or a `dataId` path to extract. Purely declarative: it cannot express conditional logic (e.g. "set X only if field Y is present"). Conditional derivations are handled in poller code instead, not by extending this model.
_Avoid_: field mapping, prop rule.

**isInsight**:
A flag on a PropDefinition marking it as a dynamic column in the corresponding R2 Data Catalog (Iceberg) table — `uniscrm.user`, `uniscrm.content`, `uniscrm.event`. Free-text props (description, title, content_text) are deliberately never `isInsight`; they stay D1-only in `raw_data`/dedicated columns and never reach the analytics warehouse.
_Avoid_: analytics prop, tracked field.

**content_type**:
Distinguishes the kind of a `content` row from the same channel. For X: `TWEET` (default) vs `ARTICLE` (X Articles arrive as a tweet payload with an extra `article.title` structure — see `_reference/x/post.json`). Detected by presence-checking the raw payload in poller code, not by metadata.
_Avoid_: post type, media type.

**deactivated_reason**:
A free-text column on `channels` recording *why* `is_active` was set to 0, distinguishing causes that must never be conflated: `'tier_limit'` (set by tier-enforcement downgrade/expiry in `admin/src/routes/webhook.ts` and `subscription-db.ts`; a later tier upgrade's reactivation query matches on this exact string) vs. `'byok_merged source_channel_id=<id>'` (set when an X BYOK OAuth callback frees a channel row's `(channel_type, source_channel_id)` slot because the account is being taken over by a different row — see `docs/adr/0003-...`). A row deactivated for one reason must never be swept up by reactivation logic written for another.
_Avoid_: disconnect reason, status reason — this is specifically about why `is_active` flipped to 0, not a general channel status field.

**Column sortability** (`Column.sortable`/`sortType` in `shared/frontend/components/DataTable.tsx`):
Only INT and DATETIME PropDefinitions are sortable in metadata-driven list pages (`buildEntityColumns()` in `shared/frontend/lib/metadata-columns.tsx`); TEXT and ENUM_TEXT/ENUM_INT columns are not, since their comparison order isn't well-defined (alphabetical enum order, free-text collation) and R2 SQL-backed pages (e.g. link's Users list) have no server-side sort to fall back on — all sorting here is client-side over the already-fetched page. `sortType` (`'number'` | `'date'`) makes the comparison explicit rather than inferring it from `typeof` at sort time, so a numeric column doesn't silently degrade to (wrong) lexicographic order if a value ever arrives as a string.
_Avoid_: sort default, orderable — sortability is a per-column, dataType-derived property, not a page-level setting.

**Compaction**:
The periodic job (in `analytics/compactor`, run daily from the `analytics` Worker's cron) that rewrites an R2 Data Catalog table down to one row per business key (e.g. `tenant_id`+`channel_id`+`source_user_id` for `uniscrm.user`, `tenant_id`+`channel_id`+`source_content_id` for `uniscrm.content`), keeping the latest by `updated_at`. Exists because R2 Pipelines sinks are append-only (no upsert/merge on write) — every poller/webhook write that resends an unchanged row becomes a duplicate row in the Iceberg table, so periodic compaction is the only place dedup actually happens for these tables.
_Avoid_: dedup job, cleanup job. Also distinct from Cloudflare's native R2 Data Catalog "compaction" feature (`wrangler r2 bucket catalog compaction enable`), which only merges small Parquet files for query performance and does not do row-level dedup.
