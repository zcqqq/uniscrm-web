# Flow Analytics R2 Migration Design

## Context

Content Flows (added in [Content-Triggered Flow Design](2026-07-14-content-flow-triggers-design.md)) have no per-node analytics today — only a coarse `content_flow_executions` "matched" count. User Flows' existing per-node Analytics (badges + drill-down drawer, `flow/frontend/pages/AnalyticsPage.tsx`) is powered by a D1 `flow_log` table hard-wired to `user_id NOT NULL`, which is exactly why content flows were explicitly skipped when that feature shipped (see the "intentionally skips emitNodeLogs" comment in `flow/src/index.ts`'s queue handler).

Rather than bolt a `content_id` variant onto `flow_log`, this design moves the detail event log for *both* domains to R2 Data Catalog, and introduces a small D1 counter table per domain to keep the live badges cheap. See [ADR 0004](../adr/0004-flow-node-logs-move-to-r2-only.md) for the trade-off reasoning. Content Flow analytics parity is a direct consequence of this shared rebuild, not a separate build.

## Scope

1. New R2 Data Catalog tables `flow_log` (keyed `user_id`) and `content_flow_log` (keyed `content_id`), replacing the current D1 `flow_log` table and the current (unread, abandoned) production R2 pipeline.
2. New per-tenant D1 tables `flow_counts`/`content_flow_counts`, recomputed every minute from R2, powering the live badges.
3. Rewritten `GET /api/flows/:id/analytics` (badges) and `GET /api/flows/:id/nodes/:nodeId/logs` (drill-down) — same response shapes, new backing storage, now working for both domains.
4. Content flows gain node-level logging for the first time (`emitContentNodeLogs`, mirroring `emitNodeLogs`).
5. Removal of `FLOW_LOG_QUEUE`/`handleLogQueue` (redundant once writes go straight to the R2 pipeline) and the D1 `flow_log` table.

## Out of scope

- Backfilling historical badge data — the old D1 table is dropped, the old R2 pipeline is abandoned; badges start from zero on rollout. (Explicitly accepted, not an oversight — see ADR 0004.)
- Any change to `content_flow_executions`/`flow_executions` (the coarse per-flow-execution history) — unrelated to node-level analytics.
- Any change to the `analytics` module or its report types — this is `flow`'s own editor-level analytics, not a new analytics-module report type.
- Retention/cleanup policy for `flow_log`/`content_flow_log`'s ever-growing history (same class of concern the existing `Compaction` job already manages for `uniscrm.user`/`uniscrm.content`; not solved here).

## 1. R2 tables and pipelines

Two new stream schemas in `analytics/pipelines/`, mirroring the shape of the existing (soon-abandoned) `flow-node-log-stream-schema.json`:

- `flow-log-stream-schema.json`: `tenant_id (int32, required)`, `id (string, required)`, `flow_id (string, required)`, `node_id (string, required)`, `user_id (string, required)`, `direction (string, required)`, `created_at (string, required)`. Targets R2 table `uniscrm.flow_log`.
- `content-flow-log-stream-schema.json`: identical shape with `content_id` in place of `user_id`. Targets `uniscrm.content_flow_log`.

New Cloudflare Pipelines provisioned for both (dev and production), bound in `flow/wrangler.toml` as `PIPELINE_FLOW_LOG` (repointed to the new stream, replacing the abandoned one) and a new `PIPELINE_CONTENT_FLOW_LOG`.

## 2. Write path

`emitNodeLogs` (`flow/src/index.ts`) drops its `FLOW_LOG_QUEUE` send entirely — it becomes a direct `env.PIPELINE_FLOW_LOG?.send(records)` call, nothing else. `FLOW_LOG_QUEUE`, `handleLogQueue`, `FLOW_NODE_LOG_SCHEMA`/`FLOW_NODE_LOG_INDEX`, and the `uniscrm-flow-log`/`uniscrm-flow-log-dev` queue resources are all removed — Cloudflare Pipelines already batches/buffers on write, so the extra application-level queue was redundant once nothing needs a D1 write on the other end.

A new `emitContentNodeLogs(nodeLogs, flowId, contentId, tenantId, env)` mirrors `emitNodeLogs` exactly, sending `{ tenant_id, id, flow_id, node_id, content_id, direction, created_at }` to `env.PIPELINE_CONTENT_FLOW_LOG?.send(records)`. Called from the two content-domain code paths that already compute `result.nodeLogs` today but discard them: the `queue()` handler's `if (contentId)` branch, and `scheduled()`'s `content_flow_pending` sweep. (The engine itself needs no changes — `executeFlow`/`collectActions` already populate `nodeLogs` correctly regardless of domain; only the callers were skipping the emit.)

## 3. Recompute job

A new function, called from `flow`'s existing `scheduled()` handler (already ticking every minute — `crons = ["* * * * *"]`), alongside the existing cron-trigger and pending-wait sweeps:

1. One R2 SQL query: `SELECT tenant_id, flow_id, node_id, direction, COUNT(*) as cnt FROM uniscrm.flow_log GROUP BY tenant_id, flow_id, node_id, direction` — all tenants in a single query, since `flow_log` is a shared multi-tenant table (not per-tenant). Issued synchronously via a direct HTTP call to Cloudflare's R2 SQL endpoint, matching `link/src/routes-users.ts`'s existing precedent (not the `analytics` module's async container pattern — this query is a straightforward `GROUP BY`, comparable in shape to the one already proven to work via a self-join in `analytics/src/index.ts`'s `funnel` report type).
2. A second, identical query against `uniscrm.content_flow_log`.
3. Group both result sets by `tenant_id`; for each tenant with at least one row, resolve its `d1_database_id` (`WEB_DB.tenants`) and `TenantDataDB.batch()` an overwrite of that tenant's `flow_counts`/`content_flow_counts` rows: `INSERT INTO flow_counts (flow_id, node_id, direction, count, updated_at) VALUES (...) ON CONFLICT(flow_id, node_id, direction) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at` for every `(flow_id, node_id, direction)` this tenant's query rows cover.

Full-history re-aggregation every run, always an overwrite (never an increment) — this is what makes the recompute idempotent by construction without any redelivery-safe dedup table. Table schema (both `flow_counts` and `content_flow_counts`, per-tenant D1, added to `admin/src/services/tenant-init-sql.ts` and applied to existing tenant DBs via the `operation/` migration runner):

```sql
CREATE TABLE IF NOT EXISTS flow_counts (
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
CREATE TABLE IF NOT EXISTS content_flow_counts (
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
```

## 4. Read path

**`GET /api/flows/:id/analytics`**: determines domain the same way the existing `GET /api/flows` list already does (`graph_json LIKE '%xContentTrigger%'`), then does one trivial D1 read: `SELECT node_id, direction, count FROM flow_counts WHERE flow_id = ?` (or `content_flow_counts`). Response shape unchanged: `{ nodes: { [nodeId]: { enter, exit } } }`.

**`GET /api/flows/:id/nodes/:nodeId/logs`**: same domain check, then a direct synchronous R2 SQL query against `uniscrm.flow_log`/`uniscrm.content_flow_log`, filtered `tenant_id`+`flow_id`+`node_id`+`direction='enter'`, `ORDER BY created_at DESC LIMIT 50`. Attempts a cross-table JOIN to `uniscrm.user`/`uniscrm.content` for the display name in the same query; if that's confirmed not to work during implementation (untested in this codebase — see ADR 0004), falls back to a second query against the tenant's own D1 `user`/`content` table for the matching ids, mirroring exactly what the current D1-based implementation already does via its `LEFT JOIN`. Response shape unchanged: `{ logs: [{ user_id | content_id, name | title, created_at }] }`.

Both endpoints' response contracts are byte-for-byte unchanged from today — `flow/frontend/pages/AnalyticsPage.tsx` and `AnalyticsBadges.tsx` need zero changes.

## 5. Cleanup

- Drop the D1 `flow_log` table (all existing tenant DBs, via the `operation/` migration runner — migration `0002`) and remove its `CREATE TABLE`/`CREATE INDEX` statements from `flow/src/index.ts`.
- Remove `FLOW_LOG_QUEUE`, `handleLogQueue`, and the `uniscrm-flow-log`/`uniscrm-flow-log-dev` queue bindings from `flow/wrangler.toml`.
- Abandon (do not migrate) the existing production `PIPELINE_FLOW_LOG` pipeline (stream `64ad6d8c53ed4d179de5036524f755d5`) and its R2 table — nothing has ever read it. Provision fresh pipelines for `uniscrm.flow_log`/`uniscrm.content_flow_log` and repoint the `PIPELINE_FLOW_LOG` binding at the new one.

## Testing

- Unit tests for `emitNodeLogs`'s simplified (queue-free) send, and the new `emitContentNodeLogs`, both mocking `PIPELINE_FLOW_LOG`/`PIPELINE_CONTENT_FLOW_LOG`.
- Unit tests for the recompute job's grouping/fan-out logic (mocked R2 SQL response → correct per-tenant `TenantDataDB.batch()` calls), and for its full-overwrite idempotency (running it twice with the same R2 data produces the same D1 state, not doubled counts).
- Unit tests for both rewritten endpoints' domain-detection branch and D1-read (badges) / R2-query-with-fallback (drill-down) paths.
- Manual dev verification: publish a Content Flow, trigger it, confirm badges appear within a minute and the drill-down drawer lists the actual content item; confirm an existing User Flow's badges/drawer still work identically after the storage swap.

## Non-goals

- Retention/compaction for `flow_log`/`content_flow_log` (deferred, same open class of problem as other R2 tables).
- Any historical backfill (see Out of scope).
- Changing the `analytics` module's report types to expose flow data (a possible future consumer of these same R2 tables, not built here).
