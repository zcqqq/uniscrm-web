# Migrate insight-analytics from AE to R2 Data Catalog + Pipelines + Container

## Context

Analytics Engine limitations drove this redesign:
- 90-day data retention (need permanent history)
- No JOINs/window functions (interval analysis computed in JS, slow)
- Append-only (can't update user data)

Target: Replace AE entirely with **Pipelines → R2 Iceberg** (write) + **Container + wrangler r2 sql** (query). All analytics become async reports with results stored in D1.

**Scope**: First iteration only implements **interval analytics**. Event analytics and User analytics pages are deleted from frontend (will be rebuilt later on the new infra).

## Architecture

```
Write Path (real-time):
  link Worker → PIPELINE_EVENT.send() → R2 Iceberg (uniscrm.event)
  link Worker → PIPELINE_USER.send() → R2 Iceberg (uniscrm.user)  [upsert]
  flow Worker → PIPELINE_FLOW_NODE_LOG.send() → R2 Iceberg (uniscrm.flow_node_log)

Query Path (async, interval analytics):
  Frontend → POST /api/reports → D1 (status=pending) → Queue
  Queue → Container (wrangler r2 sql query) → D1 (status=ready, results_json)
  Frontend polls GET /api/reports/:id until ready
```

## Phase 1: Infrastructure Setup

### R2 Bucket + Data Catalog
- Shared bucket: `uniscrm-dev` (dev) / `uniscrm` (prod) — all tenants in one bucket
- Enable Data Catalog on each
- `wrangler r2 bucket create uniscrm-dev`
- `wrangler r2 bucket catalog enable uniscrm-dev`

### Metadata-driven Pipeline Schema

Add `isInsight?: boolean` to `metadata/dataTypes.ts` PropDefinition. Only props marked `isInsight: true` are written to Iceberg tables.

**Event table** (`uniscrm.event`):
- Fixed columns: `tenant_id INT`, `id TEXT`, `user_id TEXT`, `channel_id TEXT`, `event_type TEXT`, `event_time TIMESTAMP`, `created_at TIMESTAMP`
- Dynamic columns: props from metadata where `isInsight: true` (e.g. `followers_count INT`, `verified_type TEXT`)

**User table** (`uniscrm.user`) — uses Iceberg ACID update:
- Fixed columns: `tenant_id INT`, `id TEXT`, `channel_type TEXT`, `name TEXT`, `username TEXT`, `is_active INT`, `is_follow INT`, `is_followed INT`, `created_at TIMESTAMP`, `updated_at TIMESTAMP`, `profile_id TEXT`
- Dynamic columns: props from metadata where `isInsight: true`

**Flow node log table** (`uniscrm.flow_node_log`):
- Columns: `tenant_id INT`, `id TEXT`, `flow_id TEXT`, `node_id TEXT`, `user_id TEXT`, `direction TEXT`, `created_at TIMESTAMP`

All tables partitioned by `tenant_id`.

### Pipelines (3 per env)
- `pipeline-event-dev` → sink to `uniscrm.event`
- `pipeline-user-dev` → sink to `uniscrm.user`
- `pipeline-flow-node-log-dev` → sink to `uniscrm.flow_node_log`

## Phase 2: Metadata Change

### `metadata/dataTypes.ts`
```typescript
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  label: LocalizedString;
  isInsight?: boolean;          // ← NEW: write to R2 Iceberg when true
  enums?: { value: string | number; label: LocalizedString }[];
}
```

### `metadata/x.ts`
Mark relevant props:
```typescript
{ propId: "followers_count", dataType: "INT", label: {...}, isInsight: true },
{ propId: "following_count", dataType: "INT", label: {...}, isInsight: true },
{ propId: "verified_type", dataType: "ENUM_TEXT", label: {...}, isInsight: true },
// ... others as needed
```

## Phase 3: Container (AnalyticsContainer)

### `insight-analytics/Dockerfile`
```dockerfile
FROM node:20-slim
RUN npm install -g wrangler
WORKDIR /app
COPY server.js .
EXPOSE 8080
CMD ["node", "server.js"]
```

### `insight-analytics/server.js`
HTTP server on port 8080:
- `GET /health` → 200
- `POST /query` → receives `{type, params, tenant_id, warehouse}`, builds SQL, executes `wrangler r2 sql query <warehouse> "<SQL>"`, parses output, returns JSON results

Environment: `CLOUDFLARE_API_TOKEN` (for wrangler auth)

### Container class in `src/index.ts`
```typescript
export class AnalyticsContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
}
```

Config: `instance_type = "basic"`, `max_instances = 1` (dev) / `3` (prod)

## Phase 4: insight-analytics Worker Changes

### New D1 migration (`migrations/0003_create_analytics_reports.sql`)
```sql
CREATE TABLE IF NOT EXISTS analytics_reports (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'interval' (event/user later)
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  results_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reports_tenant ON analytics_reports(tenant_id, type, created_at DESC);
```

### `wrangler.toml` changes
Remove:
- `analytics_engine_datasets` (AE_EVENT)
- `triggers.crons`
- env vars: `AE_DATASET_EVENT`, `AE_DATASET_FLOW_NODE_LOG`

Add:
- Container: `class_name = "AnalyticsContainer"`, `image = "./Dockerfile"`, `instance_type = "basic"`
- Durable Object binding: `ANALYTICS_CONTAINER` → `AnalyticsContainer`
- Queue producer: `ANALYTICS_QUEUE` → `analytics-jobs-dev`
- Queue consumer: `analytics-jobs-dev`, batch_size=1, timeout=60
- Migration: `new_sqlite_classes = ["AnalyticsContainer"]`
- Env var: `R2_WAREHOUSE` = warehouse name from Data Catalog

### `src/types.ts`
Remove: `AE_EVENT`, `AE_DATASET_EVENT`, `AE_DATASET_FLOW_NODE_LOG`
Add: `ANALYTICS_CONTAINER`, `ANALYTICS_QUEUE`, `R2_WAREHOUSE`

### `src/index.ts` — API endpoints

Keep existing `/api/analyses` endpoints for now (they compute in-process from D1, still useful as fallback).

Add new:
| Endpoint | Purpose |
|----------|---------|
| `POST /api/reports` | Submit report (type + params) → insert D1 → enqueue |
| `GET /api/reports` | List reports for tenant (paginated, filterable by type) |
| `GET /api/reports/:id` | Get report status + results |
| `DELETE /api/reports/:id` | Delete report |

Queue handler: receive message → startAndWaitForPorts → container.fetch("/query") → update D1

### Files to delete
- `src/services/ae-sync.ts`
- `src/services/ae-query.ts`

### D1 cleanup migration (`migrations/0004_drop_ae_sync_cursors.sql`)
```sql
DROP TABLE IF EXISTS ae_sync_cursors;
```

## Phase 5: Pipeline Writes in Source Workers

### link Worker — Event Pipeline
```toml
[[env.dev.pipelines]]
binding = "PIPELINE_EVENT"
stream = "<stream-id>"
```

After D1 event insert:
```typescript
await env.PIPELINE_EVENT.send([{
  tenant_id,
  id: event.id,
  user_id: event.user_id,
  channel_id: event.channel_id,
  event_type: event.event_type,
  event_time: event.event_time,
  created_at: event.created_at,
  // + isInsight props extracted from raw_data per metadata
}]);
```

### link Worker — User Pipeline (upsert)
```toml
[[env.dev.pipelines]]
binding = "PIPELINE_USER"
stream = "<stream-id>"
```

On user create/update:
```typescript
await env.PIPELINE_USER.send([{
  tenant_id,
  id: user.id,
  channel_type: user.channel_type,
  name: user.name,
  username: user.username,
  is_active: user.is_active,
  is_follow: user.is_follow,
  is_followed: user.is_followed,
  created_at: user.created_at,
  updated_at: user.updated_at,
  profile_id: user.profile_id,
  // + isInsight props
}]);
```

Note: Iceberg supports upsert/merge operations for the user table (ACID). Pipeline sink config should use merge-on-key (`tenant_id`, `id`).

### flow Worker — Flow Node Log Pipeline
Replace `FLOW_ANALYTICS.writeDataPoint(...)` with:
```typescript
await env.PIPELINE_FLOW_NODE_LOG.send([{
  tenant_id,
  id: logId,
  flow_id: flowId,
  node_id: nodeId,
  user_id: userId,
  direction,
  created_at: new Date().toISOString(),
}]);
```

Remove from flow/wrangler.toml:
- `FLOW_ANALYTICS` AE binding
- `AE_DATASET_FLOW_NODE_LOG` env var

## Phase 6: Frontend Changes (Interval Only)

### Delete pages:
- `frontend/pages/EventAnalytics.tsx`
- `frontend/pages/UserAnalytics.tsx`

### Update `frontend/components/TabNav.tsx`
Remove Event/User tabs. Only show "Interval Analytics".

### Update `frontend/App.tsx`
Remove routes for `/` (event) and `/users`. Root redirects to interval.

### Keep existing interval pages:
- `AnalysisList.tsx` — already works with async pattern
- `AnalysisCreate.tsx` — still submits to `/api/analyses` (fallback D1 compute)
- `AnalysisResult.tsx` — already polls status

Later iteration: wire interval to new `/api/reports` endpoint with R2 SQL backend.

## Phase 7: R2 SQL Query for Interval Analytics (in Container)

```sql
WITH ordered AS (
  SELECT user_id, event_type, event_time,
    LEAD(event_type) OVER (PARTITION BY user_id ORDER BY event_time) as next_type,
    LEAD(event_time) OVER (PARTITION BY user_id ORDER BY event_time) as next_time
  FROM uniscrm.event
  WHERE tenant_id = ? AND event_type IN (?, ?) AND event_time BETWEEN ? AND ?
)
SELECT
  COUNT(*) as pair_count,
  COUNT(DISTINCT user_id) as profile_count,
  MIN(EPOCH(next_time) - EPOCH(event_time)) as min_interval,
  MAX(EPOCH(next_time) - EPOCH(event_time)) as max_interval,
  AVG(EPOCH(next_time) - EPOCH(event_time)) as avg_interval,
  MEDIAN(EPOCH(next_time) - EPOCH(event_time)) as median_interval
FROM ordered
WHERE event_type = ? AND next_type = ?
```

If R2 SQL window function syntax differs, fallback: query raw events from R2 SQL, compute stats in container JS code (same as current `computeIntervals` + `computeStats`).

## Verification

1. **Pipeline write**: Create event in link-dev → verify with `wrangler r2 sql query`
2. **User upsert**: Update user in link-dev → verify updated row in R2 SQL
3. **Container**: SSH into container, manually test R2 SQL query
4. **Full flow**: Frontend submit interval analysis → poll → results display
5. **Cold start**: Measure container wakeup time after sleep (target <10s)

## Implementation Order

1. Metadata change (`isInsight` on PropDefinition)
2. Infrastructure (R2 bucket `uniscrm-dev`, catalog, 3 Pipelines)
3. Pipeline writes in link Worker (event + user)
4. Pipeline writes in flow Worker (+ remove AE binding)
5. Container (Dockerfile + server.js) + test R2 SQL manually
6. insight-analytics Worker (new endpoints, queue, Container, remove AE/cron)
7. Frontend (delete Event/User pages, keep interval as-is for now)
8. Wire interval to new R2 SQL backend via `/api/reports`
9. Deploy + verify end-to-end

## Mermaid Sequence Diagram

Save to `insight-analytics/src/sequence.md` per CLAUDE.md requirement (async queue flow).
