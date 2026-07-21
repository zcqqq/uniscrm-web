# Flow List "No. Triggered" — R2-Backed Cached Count Design

## Context

The user/content flow list pages (`flow/frontend/pages/FlowsPage.tsx`) show a "No. Triggered"
column per flow. Today it comes from a live `GET /api/flows` subquery that sums two dedicated
per-row log tables, `flow_executions` and `content_flow_executions` (both in the shared `flow` D1
database):

```sql
(SELECT COUNT(*) FROM flow_executions WHERE flow_id = f.id) +
(SELECT COUNT(*) FROM content_flow_executions WHERE flow_id = f.id) as trigger_count
```

This number can disagree with the "Entered" count shown for the same flow's trigger node in the
node-analytics drawer (`/api/flows/:id/analytics`), which is derived from R2 log aggregation
(`flow_counts`/`content_flow_counts`, populated every minute by `recomputeFlowCounts()` from
`uniscrm.flow_log`/`uniscrm.content_flow_log`). Two independent counting mechanisms for
conceptually the same event is the root cause of the discrepancy investigated earlier this session
(flow list showed 290, node analytics showed 205, actual bookmark count was 0).

This design makes the list page use the same source of truth as the node-analytics drawer, and
removes the now-redundant `flow_executions`/`content_flow_executions` tables and their per-trigger
write path.

## Current State (facts, not design)

- `flow_executions`/`content_flow_executions`: shared `flow` D1 db, already have `tenant_id`.
  Written on every trigger fire (~20 call sites across `flow/src/index.ts`); read in exactly one
  place — the `trigger_count` subquery above. No other reader anywhere in the repo.
- `flow_counts`/`content_flow_counts`: **per-tenant** D1 db, no `tenant_id` column (PK is
  `(flow_id, node_id, direction)`, `flow_id` is a UUID so this is already globally unique).
  Populated by `recomputeFlowCounts()` (`flow/src/index.ts:138-182`), which runs every minute from
  the `scheduled()` cron handler, aggregating full-history `GROUP BY` queries against
  `uniscrm.flow_log`/`uniscrm.content_flow_log` in R2, then upserting per-tenant over the D1 HTTP
  API (`TenantDataDB`, one HTTP round-trip per tenant per tick).
- Verified empty in all 3 production tenant dbs today (pure derived cache, not user data).
- `flows` table (shared `flow` db) has no trigger-count or trigger-node cache column today.
- No code currently prevents a flow's graph from containing more than one trigger-type node
  (`xTrigger`/`cronTrigger`/`xContentTrigger`/`youtubeContentTrigger`). Verified: 0 of 4 dev flows
  and 0 of 3 prod flows currently violate a single-trigger constraint.
- `content_trigger_dedup` (per-tenant db) is unrelated to this feature — it exists solely so the X
  list-posts and YouTube channel pollers (which have no `since_id`/cursor) don't re-fire a flow
  trigger for content they already fired one for on a previous poll tick.

## Design

### 1. Delete `flow_executions` / `content_flow_executions`

Drop both tables (new migration) and remove every write call site in `flow/src/index.ts`. They
have no other purpose than feeding the count this design replaces.

### 2. Move `flow_counts` / `content_flow_counts` into the shared `flow` D1 db

New migration creates both tables in `flow`'s own migrations directory, same shape as today plus
a `tenant_id INTEGER NOT NULL` column (indexed), same `(flow_id, node_id, direction)` primary key.

`recomputeFlowCounts()`'s write path changes from N per-tenant `TenantDataDB` HTTP upserts to
direct `env.FLOW_DB` prepared-statement upserts — a straight simplification (no more per-tenant
round-trips), not just a relocation.

`/api/flows/:id/analytics` (the node-analytics drawer's per-node badge counts) updates its read
from the tenant's D1 (over HTTP) to `env.FLOW_DB` directly. The node-detail drawer's timestamped
log list (`/api/flows/:id/nodes/:nodeId/logs`) is unaffected — it already reads straight from R2
and never touched these count tables.

Per-tenant copies of `flow_counts`/`content_flow_counts`: removed from the new-tenant provisioning
template (`admin/src/services/tenant-init-sql.ts`). Existing tenant dbs' copies are left in place,
un-dropped, currently-empty, and permanently unread from this point on.

### 3. Cache the list-page count on `flows.trigger_count`

New nullable `trigger_count INTEGER` column on the shared `flows` table. `recomputeFlowCounts()`
computes it once per cron tick, per flow: parse `graph_json`, find the flow's one trigger-type
node, look up that node's `direction = 'enter'` count from the same R2 aggregation the function
already computed that tick, and write it via `UPDATE flows SET trigger_count = ? WHERE id = ?`.
Flows with no recognized trigger node, or no R2 activity yet, keep `trigger_count = NULL`.

`GET /api/flows`'s query drops both `flow_executions`/`content_flow_executions` subqueries and
selects `f.trigger_count` directly — a plain column read, no join, no per-request R2 or tenant-db
call.

Frontend (`FlowsPage.tsx`): no change needed. It already renders `flow.trigger_count || "-"`,
which naturally shows "-" for `null`.

### 4. Single-trigger-node editor constraint

`flow/frontend/store/flow-editor.ts` (and wherever nodes are added from the sidebar) is changed so
a graph can never contain more than one trigger-type node — attempting to add a second is
rejected. No existing flow (dev or prod) currently has more than one, so this introduces no
migration/compatibility concern; it only forecloses a state that was previously allowed by
omission but never actually used.

## Out of scope

- Fixing the dev-only flow with the dead legacy `contentTrigger` node type (pre-existing, unrelated
  to this change, not present in production).
- Applying the still-pending `0014_flows_domain.sql` production migration — it will run
  automatically the next time "Deploy Production" is manually triggered, per existing CI setup;
  this plan's new migrations ride along with it.
- Any change to `content_trigger_dedup` — confirmed working as intended, unrelated table.

## Migration/compatibility notes

- No production customer data is at risk: `flow_counts`/`content_flow_counts` are 0 rows in all 3
  prod tenant dbs today, and `flow_executions`/`content_flow_executions` only ever fed a count that
  is being replaced outright.
- `flows.trigger_count` starts `NULL` for all existing flows after migration and is fully
  repopulated by the very next cron tick (within one minute).
