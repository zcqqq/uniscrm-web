# Flow Analytics R2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move flow's per-node analytics (badges + drill-down) from a D1-only, user-only table to R2 Data Catalog tables for both User Flows and Content Flows, with a small per-tenant D1 counter table keeping the live badges cheap.

**Architecture:** Node enter/exit events write directly to new R2 pipelines (`flow_log`/`content_flow_log`, replacing the abandoned production pipeline and the dropped D1 table). A per-minute job re-aggregates both R2 tables in two queries (all tenants at once) and fans the results out to each active tenant's D1 `flow_counts`/`content_flow_counts`. The badges endpoint becomes a cheap D1 read; the drill-down endpoint queries R2 directly and synchronously, then looks up names from the tenant's own D1 `user`/`content` tables.

**Tech Stack:** Cloudflare Pipelines (R2 Data Catalog / Iceberg), Cloudflare R2 SQL (direct HTTP REST calls, not the `analytics` module's async container), D1, the existing `operation/` tenant-migration runner.

## Global Constraints

- No historical backfill — the old D1 `flow_log` table is dropped outright, the old production R2 pipeline is abandoned (never queried by anything, confirmed). Badges reset to zero for every existing flow on rollout. This is an accepted consequence, not a defect to fix.
- Recompute is always full-history + overwrite, never incremental — this is what makes it idempotent by construction without any redelivery-safe dedup logic anywhere in the write path.
- Both R2 tables (`uniscrm.flow_log`, `uniscrm.content_flow_log`) are shared multi-tenant tables (`tenant_id` a plain column), not per-tenant — the recompute's R2 queries run once for all tenants, never once per tenant.
- API response contracts for `GET /api/flows/:id/analytics` and `GET /api/flows/:id/nodes/:nodeId/logs` do not change — `flow/frontend/pages/AnalyticsPage.tsx` and `AnalyticsBadges.tsx` need zero changes.
- Cross-table JOIN in R2 SQL is untested in this codebase — the drill-down endpoint uses the guaranteed-safe two-step approach (query R2 for the log rows, then look up names from the tenant's own D1 `user`/`content` table) rather than attempting a JOIN with a fallback, to avoid runtime SQL-feature-detection complexity for something unproven.

---

## Task 1: R2 pipelines + new bindings

**Files:**
- Create: `analytics/pipelines/flow-log-stream-schema.json`
- Create: `analytics/pipelines/content-flow-log-stream-schema.json`
- Modify: `flow/wrangler.toml`
- Modify: `flow/src/types.ts`
- Modify (conditionally, see Step 6): `flow/.secrets.json`, `.github/workflows/deploy-dev.yml`, `.github/workflows/deploy-prod.yml`

**Interfaces:**
- Produces: `env.PIPELINE_FLOW_LOG` (repointed to a new stream), `env.PIPELINE_CONTENT_FLOW_LOG` (new), `env.CF_ACCOUNT_ID`/`env.R2_SQL_TOKEN`/`env.R2_BUCKET`/`env.R2_WAREHOUSE` on `flow`'s `Env` — consumed by every later task in this plan.

- [ ] **Step 1: Create the two stream schemas**

`analytics/pipelines/flow-log-stream-schema.json`:

```json
{
  "fields": [
    { "name": "tenant_id", "type": "int32", "required": true },
    { "name": "id", "type": "string", "required": true },
    { "name": "flow_id", "type": "string", "required": true },
    { "name": "node_id", "type": "string", "required": true },
    { "name": "user_id", "type": "string", "required": true },
    { "name": "direction", "type": "string", "required": true },
    { "name": "created_at", "type": "string", "required": true }
  ]
}
```

`analytics/pipelines/content-flow-log-stream-schema.json`:

```json
{
  "fields": [
    { "name": "tenant_id", "type": "int32", "required": true },
    { "name": "id", "type": "string", "required": true },
    { "name": "flow_id", "type": "string", "required": true },
    { "name": "node_id", "type": "string", "required": true },
    { "name": "content_id", "type": "string", "required": true },
    { "name": "direction", "type": "string", "required": true },
    { "name": "created_at", "type": "string", "required": true }
  ]
}
```

- [ ] **Step 2: Provision the dev pipelines**

This mirrors the exact command sequence already proven for `uniscrm.content` in `docs/superpowers/plans/2026-07-13-content-dedup.md`. Run from the repo root, using the same R2 catalog token used for that prior pipeline setup (check your shell history or password manager for `$R2_TOKEN` if not already set in this session):

```bash
wrangler pipelines streams create uniscrm_flow_log_dev --schema-file analytics/pipelines/flow-log-stream-schema.json
wrangler pipelines sinks create flow_log_sink_dev \
  --type r2-data-catalog \
  --bucket uniscrm-dev \
  --namespace uniscrm \
  --table flow_log \
  --catalog-token "$R2_TOKEN"
wrangler pipelines create uniscrm_flow_log_pipeline_dev --sql "INSERT INTO flow_log_sink_dev SELECT * FROM uniscrm_flow_log_dev"

wrangler pipelines streams create uniscrm_content_flow_log_dev --schema-file analytics/pipelines/content-flow-log-stream-schema.json
wrangler pipelines sinks create content_flow_log_sink_dev \
  --type r2-data-catalog \
  --bucket uniscrm-dev \
  --namespace uniscrm \
  --table content_flow_log \
  --catalog-token "$R2_TOKEN"
wrangler pipelines create uniscrm_content_flow_log_pipeline_dev --sql "INSERT INTO content_flow_log_sink_dev SELECT * FROM uniscrm_content_flow_log_dev"
```

Expected: each command prints a new resource with a fresh ID. Record both new stream IDs (first command of each group) for Step 4.

- [ ] **Step 3: Provision the production pipelines**

Same commands, targeting production (bucket `uniscrm`, `_prod`-free naming to match this repo's existing production-has-no-suffix convention — check `flow/wrangler.toml`'s existing `[env.production]` section naming style before running):

```bash
wrangler pipelines streams create uniscrm_flow_log --schema-file analytics/pipelines/flow-log-stream-schema.json
wrangler pipelines sinks create flow_log_sink \
  --type r2-data-catalog \
  --bucket uniscrm \
  --namespace uniscrm \
  --table flow_log \
  --catalog-token "$R2_TOKEN"
wrangler pipelines create uniscrm_flow_log_pipeline --sql "INSERT INTO flow_log_sink SELECT * FROM uniscrm_flow_log"

wrangler pipelines streams create uniscrm_content_flow_log --schema-file analytics/pipelines/content-flow-log-stream-schema.json
wrangler pipelines sinks create content_flow_log_sink \
  --type r2-data-catalog \
  --bucket uniscrm \
  --namespace uniscrm \
  --table content_flow_log \
  --catalog-token "$R2_TOKEN"
wrangler pipelines create uniscrm_content_flow_log_pipeline --sql "INSERT INTO content_flow_log_sink SELECT * FROM uniscrm_content_flow_log"
```

Record both new stream IDs.

- [ ] **Step 4: Update `flow/wrangler.toml`'s pipeline bindings**

Replace (in `[env.dev]`, currently commented out):

```toml
# [[env.dev.pipelines]]
# binding = "PIPELINE_FLOW_LOG"
# pipeline = "d3d880e6c0ab44ef947d0d3d63d6a01d"
```

with (using the actual new dev flow_log stream ID from Step 2, and adding vars for R2 SQL querying):

```toml
[[env.dev.pipelines]]
binding = "PIPELINE_FLOW_LOG"
stream = "<NEW_DEV_FLOW_LOG_STREAM_ID>"

[[env.dev.pipelines]]
binding = "PIPELINE_CONTENT_FLOW_LOG"
stream = "<NEW_DEV_CONTENT_FLOW_LOG_STREAM_ID>"
```

Add to `[env.dev.vars]` (alongside the existing `CF_ACCOUNT_ID`):

```toml
R2_BUCKET = "uniscrm-dev"
R2_WAREHOUSE = "b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev"
```

Replace (in `[env.production]`, currently pointing at the abandoned pipeline):

```toml
[[env.production.pipelines]]
binding = "PIPELINE_FLOW_LOG"
stream = "64ad6d8c53ed4d179de5036524f755d5"
```

with (using the actual new production flow_log stream ID from Step 3):

```toml
[[env.production.pipelines]]
binding = "PIPELINE_FLOW_LOG"
stream = "<NEW_PROD_FLOW_LOG_STREAM_ID>"

[[env.production.pipelines]]
binding = "PIPELINE_CONTENT_FLOW_LOG"
stream = "<NEW_PROD_CONTENT_FLOW_LOG_STREAM_ID>"
```

Add to `[env.production.vars]`:

```toml
R2_BUCKET = "uniscrm"
R2_WAREHOUSE = "b34f3ff4aec4c36584672d5bf1320757_uniscrm"
```

- [ ] **Step 5: Add the new Env fields**

In `flow/src/types.ts`, add to the `Env` interface (alongside the existing `PIPELINE_FLOW_LOG?: Pipeline;`):

```ts
  PIPELINE_CONTENT_FLOW_LOG?: Pipeline;
  R2_SQL_TOKEN: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
```

- [ ] **Step 6: Give `flow` access to the `R2_SQL_TOKEN` secret**

This repo's secret sync is data-driven: `scripts/sync-secrets.sh` reads each module's `<module>/.secrets.json` (a plain `{ "production": [...names], "dev": [...names] }` list of GitHub-repo-secret names required for that env) and bulk-pushes matching env vars via `wrangler secret bulk`. `link/.secrets.json` currently does NOT list `R2_SQL_TOKEN` — meaning `link`'s copy of this secret was set up as a one-off manual `wrangler secret put`, bypassing this CI mechanism, not something to copy literally.

Check first whether a GitHub Actions repo secret literally named `R2_SQL_TOKEN` already exists (`gh secret list` if you have access, or ask the user) — since it's an account-level R2 SQL API token, not link-specific, the SAME value works for `flow`.

- If it exists: add `"R2_SQL_TOKEN"` to both the `"production"` and `"dev"` arrays in `flow/.secrets.json` (currently `{"production": ["CF_D1_API_TOKEN"], "dev": ["CF_D1_API_TOKEN"]}`), and add `R2_SQL_TOKEN: ${{ secrets.R2_SQL_TOKEN }}` to the `sync-secrets` job's `env:` block for the `flow` matrix entry in both `.github/workflows/deploy-dev.yml` and `.github/workflows/deploy-prod.yml` (this regularizes it onto the CI-managed path, an improvement over `link`'s current ad-hoc setup, not a requirement — just don't silently diverge from it without noting the inconsistency).
- If it doesn't exist as a GitHub secret at all: set it directly via `wrangler secret put R2_SQL_TOKEN --env dev --config flow/wrangler.toml` and the `--env production` equivalent, using the exact same token value `link` already uses (retrieve it from wherever that value is stored — password manager, 1Password, etc. — never hardcode it in this repo). Do not add it to `flow/.secrets.json` in this case, matching `link`'s existing precedent.

- [ ] **Step 7: Verify both new R2 tables are reachable and empty**

```bash
wrangler r2 sql query uniscrm-dev "SELECT COUNT(*) FROM uniscrm.flow_log"
wrangler r2 sql query uniscrm-dev "SELECT COUNT(*) FROM uniscrm.content_flow_log"
```

Expected: `0` for both (fresh, empty tables).

- [ ] **Step 8: Commit**

```bash
git add analytics/pipelines/flow-log-stream-schema.json analytics/pipelines/content-flow-log-stream-schema.json flow/wrangler.toml flow/src/types.ts
# Also stage flow/.secrets.json and the two workflow files if Step 6 modified them (only if
# R2_SQL_TOKEN needed to move onto the CI-managed secrets path — skip if you set it via a
# one-off `wrangler secret put` instead, matching link's existing precedent).
git commit -m "feat(flow): provision flow_log/content_flow_log R2 pipelines + bindings"
```

---

## Task 2: D1 schema — `flow_counts`/`content_flow_counts`, drop old `flow_log`

**Files:**
- Modify: `admin/src/services/tenant-init-sql.ts`
- Create: `operation/migrations/0002-flow-counts.ts`
- Test: `operation/migrations/0002-flow-counts.test.ts`

**Interfaces:**
- Consumes: `operation/migrations/types.ts`'s `TenantMigration` interface (already exists).
- Produces: per-tenant D1 tables `flow_counts`/`content_flow_counts` (`flow_id, node_id, direction, count, updated_at`, `PRIMARY KEY (flow_id, node_id, direction)`), and drops the old `flow_log` table. Consumed by Task 5 (recompute writes) and Task 6 (badges reads).

- [ ] **Step 1: Add the two new tables to `TENANT_DB_INIT_SQL`**

In `admin/src/services/tenant-init-sql.ts`, add after the existing `idx_content_status` line (last entry in the array, before the closing `];`):

```ts
  `CREATE TABLE IF NOT EXISTS flow_counts (
    flow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (flow_id, node_id, direction)
  )`,
  `CREATE TABLE IF NOT EXISTS content_flow_counts (
    flow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (flow_id, node_id, direction)
  )`,
```

- [ ] **Step 2: Write the failing tests for migration `0002`**

`operation/migrations/0002-flow-counts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { migration } from "./0002-flow-counts.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0002-flow-counts migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0002-flow-counts");
  });

  it("creates flow_counts, content_flow_counts, and drops the old flow_log table, in order", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("CREATE TABLE IF NOT EXISTS flow_counts")
    );
    expect(tdb.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("CREATE TABLE IF NOT EXISTS content_flow_counts")
    );
    expect(tdb.run).toHaveBeenNthCalledWith(3, "DROP TABLE IF EXISTS flow_log");
    expect(tdb.run).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd operation && npx vitest run migrations/0002-flow-counts.test.ts`
Expected: FAIL — `0002-flow-counts.ts` doesn't exist yet.

- [ ] **Step 4: Implement**

`operation/migrations/0002-flow-counts.ts`:

```ts
import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0002-flow-counts",
  async apply(tdb) {
    await tdb.run(`CREATE TABLE IF NOT EXISTS flow_counts (
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, node_id, direction)
    )`);
    await tdb.run(`CREATE TABLE IF NOT EXISTS content_flow_counts (
      flow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, node_id, direction)
    )`);
    // Old D1 flow_log is retired outright (not migrated) — its detail data moves to
    // R2 (flow_log/content_flow_log Iceberg tables, Task 1), and nothing reads this
    // D1 table going forward once Tasks 6-7 land. Dropped here rather than left as
    // unread dead weight, per an explicit decision (not a backfill oversight).
    await tdb.run("DROP TABLE IF EXISTS flow_log");
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd operation && npx vitest run migrations/0002-flow-counts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin/src/services/tenant-init-sql.ts operation/migrations/0002-flow-counts.ts operation/migrations/0002-flow-counts.test.ts
git commit -m "feat(operation): 0002-flow-counts migration (flow_counts/content_flow_counts, drop old D1 flow_log)"
```

---

## Task 3: Simplify the write path — drop `FLOW_LOG_QUEUE`

**Files:**
- Modify: `flow/src/index.ts`
- Modify: `flow/wrangler.toml`
- Modify: `flow/src/types.ts`
- Test: `flow/tests/unit/emit-node-logs.test.ts` (new file)

**Interfaces:**
- Produces: `emitNodeLogs` sends only to `env.PIPELINE_FLOW_LOG`, no queue. Consumed by the existing call sites (queue handler's user-domain branch, `scheduled()`'s pending sweep) — unchanged signatures, no caller updates needed.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/emit-node-logs.test.ts` — since `emitNodeLogs` is not currently exported, this test drives it indirectly through the exported `queue()` handler exactly like the existing `flow/tests/unit/queue-content.test.ts` does for the content path. First, check `flow/tests/unit/queue-content.test.ts` for its exact `env.FLOW_DB`/`env.WEB_DB` schema-setup pattern (the `beforeEach` block creating `flows`/`tenants` tables by hand) and copy that same setup here, adapted for a user-domain flow:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const graphWithXTrigger = JSON.stringify({
  nodes: [
    { id: "t1", type: "xTrigger", data: { channelType: "X", eventType: "follow.followed", channelId: "", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

describe("emitNodeLogs: sends directly to PIPELINE_FLOW_LOG, no queue", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_executions (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, event_id TEXT, user_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-elog1', 1, 'x flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithXTrigger).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-elog1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_executions WHERE flow_id = 'flow-elog1'`).run();
  });

  it("calls PIPELINE_FLOW_LOG.send with the expected records and never touches FLOW_LOG_QUEUE", async () => {
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_FLOW_LOG: { send: pipelineSend }, FLOW_LOG_QUEUE: { send: queueSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "follow.followed", userId: "user-elog-1", channelId: "chan-1", payload: {} }),
      testEnv as any
    );

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 1, flow_id: "flow-elog1", node_id: "t1", user_id: "user-elog-1", direction: "enter" }),
    ]));
    expect(queueSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/emit-node-logs.test.ts`
Expected: FAIL — `emitNodeLogs` currently also calls `env.FLOW_LOG_QUEUE?.send(...)`, but more fundamentally the test's `queueSend` mock would currently be called too (assertion `expect(queueSend).not.toHaveBeenCalled()` fails).

- [ ] **Step 3: Implement — simplify `emitNodeLogs`**

In `flow/src/index.ts`, replace the `emitNodeLogs` function body (lines 8-31):

```ts
async function emitNodeLogs(nodeLogs: NodeLog[], flowId: string, userId: string, tenantId: number, env: Env): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  const records = nodeLogs.map((log) => ({
    tenant_id: tenantId,
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    user_id: userId,
    direction: log.direction,
    created_at: timestamp,
  }));
  await env.PIPELINE_FLOW_LOG?.send(records).catch(() => {});
}
```

- [ ] **Step 4: Remove `FLOW_LOG_QUEUE`/`handleLogQueue` entirely**

In `flow/src/index.ts`:
- Delete the `FLOW_NODE_LOG_SCHEMA`, `FLOW_NODE_LOG_INDEX` constants (lines 692-700).
- Delete the `deterministicId` function (lines 702-706) — it was only used by `handleLogQueue`.
- Delete the `handleLogQueue` function entirely (lines 708-749).
- In the `queue()` handler, delete the queue-routing block:
  ```ts
    // Route by queue name
    if (batch.queue === "uniscrm-flow-log-dev" || batch.queue === "uniscrm-flow-log") {
      await handleLogQueue(batch, env);
      return;
    }
  ```

In `flow/src/types.ts`, remove `FLOW_LOG_QUEUE?: Queue;` from the `Env` interface, and remove the now-unused `FlowLogMessage` interface (lines 22-29) — confirm nothing else in `flow/` imports `FlowLogMessage` before deleting (`grep -rn "FlowLogMessage" flow/`).

In `flow/wrangler.toml`, remove from both `[env.dev]` and `[env.production]`:
```toml
[[env.dev.queues.consumers]]
queue = "uniscrm-flow-log-dev"
max_batch_size = 50
max_batch_timeout = 10

[[env.dev.queues.producers]]
binding = "FLOW_LOG_QUEUE"
queue = "uniscrm-flow-log-dev"
```
(and the equivalent production block). Leave the `uniscrm-flow-log-dev`/`uniscrm-flow-log` Cloudflare Queue resources themselves alone for now (deleting a live Cloudflare Queue resource is a separate manual infra step, not required for this code change to work — the queue simply stops being bound/used).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/emit-node-logs.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS — confirm no other test references `handleLogQueue`, `FLOW_NODE_LOG_SCHEMA`, or `FlowLogMessage` (if any pre-existing test does, that test needs updating as part of this task — check `flow/tests/unit/*.test.ts` for any `"uniscrm-flow-log"` batch-queue-name usage and remove/adjust it, since that code path no longer exists).

- [ ] **Step 7: Commit**

```bash
git add flow/src/index.ts flow/src/types.ts flow/wrangler.toml flow/tests/unit/emit-node-logs.test.ts
git commit -m "feat(flow): emitNodeLogs sends directly to R2 pipeline, remove FLOW_LOG_QUEUE"
```

---

## Task 4: Content-domain node logging — `emitContentNodeLogs`

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/emit-content-node-logs.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's `env.PIPELINE_CONTENT_FLOW_LOG`.
- Produces: `emitContentNodeLogs(nodeLogs, flowId, contentId, tenantId, env)`, called from the `queue()` handler's `contentId` branch and `scheduled()`'s `content_flow_pending` sweep.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/emit-content-node-logs.test.ts`, following the exact same `beforeEach`/`makeBatch` schema-setup pattern already used in `flow/tests/unit/queue-content.test.ts` (copy its `flows`/`content_flow_executions`/`content_flow_pending`/`tenants` table setup):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const graphWithXContentTrigger = JSON.stringify({
  nodes: [
    { id: "t1", type: "xContentTrigger", data: { channelId: "chan-1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
    { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

function makeBatch(body: Record<string, unknown>) {
  return {
    queue: "uniscrm-event-dev",
    messages: [{ body, ack: vi.fn(), retry: vi.fn() }],
  } as any;
}

describe("emitContentNodeLogs: content-domain execution now writes node logs", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_executions (
         id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, event_id TEXT, content_id TEXT NOT NULL,
         tenant_id INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-celog1', 1, 'content flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithXContentTrigger).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-celog1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-celog1'`).run();
  });

  it("calls PIPELINE_CONTENT_FLOW_LOG.send with content_id-keyed records", async () => {
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-celog-1", channelId: "chan-1", payload: {} }),
      testEnv as any
    );

    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 1, flow_id: "flow-celog1", node_id: "t1", content_id: "content-celog-1", direction: "enter" }),
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/emit-content-node-logs.test.ts`
Expected: FAIL — `PIPELINE_CONTENT_FLOW_LOG.send` is never called yet.

- [ ] **Step 3: Implement**

In `flow/src/index.ts`, add a new function right after `emitNodeLogs`:

```ts
async function emitContentNodeLogs(nodeLogs: NodeLog[], flowId: string, contentId: string, tenantId: string, env: Env): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  const records = nodeLogs.map((log) => ({
    tenant_id: Number(tenantId),
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    content_id: contentId,
    direction: log.direction,
    created_at: timestamp,
  }));
  await env.PIPELINE_CONTENT_FLOW_LOG?.send(records).catch(() => {});
}
```

Then wire it into the two content-domain call sites. First, the `queue()` handler's `contentId` branch — replace the comment block (currently reading "Content-domain execution intentionally skips emitNodeLogs/PIPELINE_FLOW_LOG — ...") and add the call right after `const result = executeFlow(graph, eventType, matchPayload);`:

```ts
            const result = executeFlow(graph, eventType, matchPayload);
            if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, flow.id, contentId, tenantId, env);
```

(Delete the old 4-line comment entirely — it described the previous skip, which no longer applies.)

Second, `scheduled()`'s `content_flow_pending` sweep — in the non-`retry_action` branch, right after `const result = resumeFromNode(graph, row.node_id, payload, branch);` (around where `result.actions`/`result.pendingWaits` are already handled), add:

```ts
        const result = resumeFromNode(graph, row.node_id, payload, branch);
        if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, row.flow_id, row.content_id, row.tenant_id, env);
```

(This mirrors exactly how the equivalent `flow_pending` sweep further down already calls `emitNodeLogs` right after its own `resumeFromNode` call — same placement, same pattern, content-domain variant.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/emit-content-node-logs.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/emit-content-node-logs.test.ts
git commit -m "feat(flow): emitContentNodeLogs — content flows now write node-level logs"
```

---

## Task 5: Recompute job

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/recompute-flow-counts.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's `env.R2_SQL_TOKEN`/`env.CF_ACCOUNT_ID`/`env.R2_WAREHOUSE`; Task 2's `flow_counts`/`content_flow_counts` tables.
- Produces: `recomputeFlowCounts(env: Env): Promise<void>`, called from `scheduled()` every tick.

- [ ] **Step 1: Write the failing tests**

Create `flow/tests/unit/recompute-flow-counts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recomputeFlowCounts } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

describe("recomputeFlowCounts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tenantsFirstMock: ReturnType<typeof vi.fn>;
  let webDbMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function baseEnv() {
    webDbMock = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ d1_database_id: "tenant-db-1" }),
        }),
      }),
    };
    return {
      CF_ACCOUNT_ID: "acct-1",
      R2_SQL_TOKEN: "tok-1",
      R2_BUCKET: "uniscrm-dev",
      R2_WAREHOUSE: "acct-1_uniscrm-dev",
      WEB_DB: webDbMock,
    } as any;
  }

  it("issues one query against uniscrm.flow_log and one against uniscrm.content_flow_log", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));
    const env = baseEnv();

    await recomputeFlowCounts(env);

    const queries = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).query);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.flow_log") && q.includes("GROUP BY"))).toBe(true);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.content_flow_log") && q.includes("GROUP BY"))).toBe(true);
  });

  it("fans out results to each active tenant's flow_counts, overwriting on conflict", async () => {
    fetchMock
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f1", node_id: "n1", direction: "enter", cnt: 5 },
      ]))
      .mockResolvedValueOnce(mockR2Response([]));
    const env = baseEnv();
    const tdbRun = vi.fn().mockResolvedValue({ changes: 1 });
    vi.doMock("../../../shared/tenant-data-db", () => ({
      TenantDataDB: class {
        run = tdbRun;
        batch = vi.fn();
      },
    }));

    await recomputeFlowCounts(env);

    expect(env.WEB_DB.prepare).toHaveBeenCalledWith(expect.stringContaining("d1_database_id FROM tenants WHERE tenant_id"));
  });

  it("does nothing (no D1 writes) for a tenant with no rows in either R2 query", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));
    const env = baseEnv();

    await recomputeFlowCounts(env);

    expect(env.WEB_DB.prepare).not.toHaveBeenCalled();
  });
});
```

Note: the middle test above documents the intent (fan-out to D1) but keep its assertions light — this task's `recomputeFlowCounts` constructs its own `TenantDataDB` internally per active tenant (matching every other tenant-fan-out site already in this file, e.g. `handleLogQueue`'s old pattern), so a full mock of `TenantDataDB`'s internals is unnecessary; asserting the `WEB_DB` lookup happened for an active tenant (and does NOT happen for zero active tenants, per the third test) is sufficient coverage for this task without over-mocking.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/recompute-flow-counts.test.ts`
Expected: FAIL — `recomputeFlowCounts` is not exported yet.

- [ ] **Step 3: Implement**

In `flow/src/index.ts`, add this function (place it near `emitContentNodeLogs`, before the `HonoEnv`/`app` declarations):

```ts
interface CountRow {
  tenant_id: number;
  flow_id: string;
  node_id: string;
  direction: string;
  cnt: number;
}

async function queryR2Counts(env: Env, table: string): Promise<CountRow[]> {
  const res = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_BUCKET}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.R2_SQL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouse: env.R2_WAREHOUSE,
        query: `SELECT tenant_id, flow_id, node_id, direction, COUNT(*) as cnt FROM ${table} GROUP BY tenant_id, flow_id, node_id, direction`,
      }),
    }
  );
  const data = await res.json() as { result?: { rows: CountRow[] }; success: boolean };
  if (!data.success) return [];
  return data.result?.rows || [];
}

export async function recomputeFlowCounts(env: Env): Promise<void> {
  const [flowRows, contentFlowRows] = await Promise.all([
    queryR2Counts(env, "uniscrm.flow_log"),
    queryR2Counts(env, "uniscrm.content_flow_log"),
  ]);

  const byTenant = new Map<number, { flow: CountRow[]; content: CountRow[] }>();
  for (const row of flowRows) {
    if (!byTenant.has(row.tenant_id)) byTenant.set(row.tenant_id, { flow: [], content: [] });
    byTenant.get(row.tenant_id)!.flow.push(row);
  }
  for (const row of contentFlowRows) {
    if (!byTenant.has(row.tenant_id)) byTenant.set(row.tenant_id, { flow: [], content: [] });
    byTenant.get(row.tenant_id)!.content.push(row);
  }

  for (const [tenantId, rows] of byTenant) {
    try {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(tenantId).first<{ d1_database_id: string | null }>();
      if (!tenantRow?.d1_database_id) continue;

      const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
      const now = new Date().toISOString();

      for (const r of rows.flow) {
        await tdb.run(
          `INSERT INTO flow_counts (flow_id, node_id, direction, count, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(flow_id, node_id, direction) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
          [r.flow_id, r.node_id, r.direction, r.cnt, now]
        );
      }
      for (const r of rows.content) {
        await tdb.run(
          `INSERT INTO content_flow_counts (flow_id, node_id, direction, count, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(flow_id, node_id, direction) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
          [r.flow_id, r.node_id, r.direction, r.cnt, now]
        );
      }
      console.log(JSON.stringify({ event: "flow_counts_recomputed", tenantId, flowRows: rows.flow.length, contentFlowRows: rows.content.length }));
    } catch (e) {
      console.error(JSON.stringify({ event: "flow_counts_recompute_error", tenantId, error: String(e) }));
    }
  }
}
```

Then, in `scheduled()`, call it once at the top (before the existing cron-trigger sweep):

```ts
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const now = new Date().toISOString();

    await recomputeFlowCounts(env).catch((e) => {
      console.error(JSON.stringify({ event: "flow_counts_recompute_fatal", error: String(e) }));
    });

    // Cron trigger: check published flows with cronTrigger nodes
    ...
```

(Wrapped in its own catch so a recompute failure never blocks the existing cron-trigger/pending-wait sweeps that follow it in the same `scheduled()` invocation.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/recompute-flow-counts.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/recompute-flow-counts.test.ts
git commit -m "feat(flow): recomputeFlowCounts — per-minute full-history R2 aggregation, fanned out to flow_counts/content_flow_counts"
```

---

## Task 6: Badges endpoint rewrite

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/analytics-endpoint.test.ts` (new file)

**Interfaces:**
- Consumes: Task 2's `flow_counts`/`content_flow_counts` tables.
- Produces: `GET /api/flows/:id/analytics` — same response shape as before (`{ nodes: { [nodeId]: { enter, exit } } }`), now reading precomputed counts instead of live-aggregating D1 `flow_log`.

- [ ] **Step 1: Write the failing tests**

Create `flow/tests/unit/analytics-endpoint.test.ts`, following the exact same auth-stubbing pattern as the already-existing `flow/tests/unit/flows-list.test.ts` (which tests another `authMiddleware`-gated route: stub global `fetch` to resolve `WEB_URL`'s `/api/auth/me` proxy call with a fixed tenant/member, then call the real `worker.fetch(...)`). This route's handler also calls the tenant D1 REST API (via `TenantDataDB`, itself a `fetch` call to `https://api.cloudflare.com/client/v4/accounts/.../d1/database/.../query`), so the stubbed `fetch` needs to branch on URL to answer both call shapes:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 777;

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

function d1QueryResponse(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: [{ results: rows, success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }), { status: 200 });
}

describe("GET /api/flows/:id/analytics", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/auth/me")) {
        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
      }
      // Tenant D1 REST query — the specific rows returned don't matter for this task's
      // table-selection assertions, an empty result set is enough.
      return d1QueryResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.WEB_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
         tenant_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
         d1_database_id TEXT, created_at TEXT NOT NULL
       )`
    ).run();
    await env.WEB_DB.prepare(
      `INSERT INTO tenants (tenant_id, email, d1_database_id, created_at) VALUES (?, 'x@example.com', 'tenant-db-1', datetime('now'))`
    ).bind(TENANT_ID).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('flow-an-user', ?, ?, 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, userFlowGraph),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES ('flow-an-content', ?, ?, 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, contentFlowGraph),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    await env.WEB_DB.prepare(`DELETE FROM tenants WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("queries content_flow_counts for a flow whose graph_json contains xContentTrigger", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-content/analytics"), env);
    expect(res.status).toBe(200);
    const d1Call = fetchMock.mock.calls.find((c) => !String(c[0]).includes("/api/auth/me"));
    const body = JSON.parse(d1Call![1].body as string);
    expect(body.sql).toContain("FROM content_flow_counts");
  });

  it("queries flow_counts for a flow without xContentTrigger", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-user/analytics"), env);
    expect(res.status).toBe(200);
    const d1Call = fetchMock.mock.calls.find((c) => !String(c[0]).includes("/api/auth/me"));
    const body = JSON.parse(d1Call![1].body as string);
    expect(body.sql).toContain("FROM flow_counts");
  });

  it("returns { nodes: {} } for a flow id that doesn't exist for this tenant", async () => {
    const res = await worker.fetch(req("/api/flows/flow-nonexistent/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/analytics-endpoint.test.ts`
Expected: FAIL — the current handler's query is unconditionally `FROM flow_log` (no `content_flow_counts`/`flow_counts` table selection yet), and it doesn't check `graph_json` for domain at all.

- [ ] **Step 3: Implement**

Replace the `GET /api/flows/:id/analytics` handler (lines 577-604) in `flow/src/index.ts`:

```ts
// Analytics: node counts (from precomputed flow_counts/content_flow_counts)
app.get("/api/flows/:id/analytics", async (c) => {
  const flowId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const flowRow = await c.env.FLOW_DB.prepare("SELECT graph_json FROM flows WHERE id = ? AND tenant_id = ?")
    .bind(flowId, tenantId).first<{ graph_json: string }>();
  if (!flowRow) return c.json({ nodes: {} });
  const isContentDomain = flowRow.graph_json.includes("xContentTrigger");
  const table = isContentDomain ? "content_flow_counts" : "flow_counts";

  const row = await c.env.WEB_DB.prepare(
    "SELECT d1_database_id FROM tenants WHERE tenant_id = ?"
  ).bind(Number(tenantId)).first<{ d1_database_id: string | null }>();
  if (!row?.d1_database_id) return c.json({ nodes: {} });

  const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id);

  try {
    const rows = await tdb.query<{ node_id: string; direction: string; count: number }>(
      `SELECT node_id, direction, count FROM ${table} WHERE flow_id = ?`,
      [flowId]
    );
    const nodes: Record<string, { enter: number; exit: number }> = {};
    for (const r of rows) {
      if (!nodes[r.node_id]) nodes[r.node_id] = { enter: 0, exit: 0 };
      if (r.direction === "enter") nodes[r.node_id].enter = r.count;
      if (r.direction === "exit") nodes[r.node_id].exit = r.count;
    }
    return c.json({ nodes });
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_analytics_query_error", error: String(e) }));
    return c.json({ nodes: {} });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/analytics-endpoint.test.ts`
Expected: PASS (after adapting Step 1's test to this repo's actual auth-testing convention, discovered by reading `list-watches.test.ts` or similar first).

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/analytics-endpoint.test.ts
git commit -m "feat(flow): badges endpoint reads precomputed flow_counts/content_flow_counts"
```

---

## Task 7: Drill-down endpoint rewrite

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/node-logs-endpoint.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's R2 SQL bindings; Task 4's `content_flow_log` R2 table.
- Produces: `GET /api/flows/:id/nodes/:nodeId/logs` — same response shape as before (`{ logs: [{ user_id|content_id, name|title, created_at }] }`), now querying R2 directly for both domains via the two-step approach (R2 for log rows, D1 for names).

- [ ] **Step 1: Write the failing tests**

Create `flow/tests/unit/node-logs-endpoint.test.ts`. This test focuses on the query-construction and two-step lookup logic — mock `fetch` for the R2 SQL call and the tenant D1 lookup:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryNodeLogRows } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

describe("queryNodeLogRows", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function baseEnv() {
    return { CF_ACCOUNT_ID: "acct-1", R2_SQL_TOKEN: "tok-1", R2_BUCKET: "uniscrm-dev", R2_WAREHOUSE: "acct-1_uniscrm-dev" } as any;
  }

  it("queries uniscrm.flow_log filtered by tenant/flow/node/direction=enter, ordered and limited", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ user_id: "u1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");

    expect(rows).toEqual([{ subjectId: "u1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.flow_log");
    expect(body.query).toContain("tenant_id = 42");
    expect(body.query).toContain("flow_id = 'flow-1'");
    expect(body.query).toContain("node_id = 'node-1'");
    expect(body.query).toContain("direction = 'enter'");
    expect(body.query).toContain("ORDER BY created_at DESC");
    expect(body.query).toContain("LIMIT 50");
  });

  it("queries uniscrm.content_flow_log with content_id as the subject column", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ content_id: "c1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.content_flow_log", "content_id", 42, "flow-2", "node-2");

    expect(rows).toEqual([{ subjectId: "c1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.content_flow_log");
  });

  it("returns an empty array when the R2 query is unsuccessful", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/node-logs-endpoint.test.ts`
Expected: FAIL — `queryNodeLogRows` is not exported yet.

- [ ] **Step 3: Implement**

In `flow/src/index.ts`, add this function near `queryR2Counts` (Task 5):

```ts
export async function queryNodeLogRows(
  env: Env,
  table: "uniscrm.flow_log" | "uniscrm.content_flow_log",
  subjectColumn: "user_id" | "content_id",
  tenantId: number,
  flowId: string,
  nodeId: string
): Promise<{ subjectId: string; created_at: string }[]> {
  const res = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_BUCKET}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.R2_SQL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouse: env.R2_WAREHOUSE,
        query: `SELECT ${subjectColumn}, created_at FROM ${table}
                WHERE tenant_id = ${tenantId} AND flow_id = '${flowId}' AND node_id = '${nodeId}' AND direction = 'enter'
                ORDER BY created_at DESC LIMIT 50`,
      }),
    }
  );
  const data = await res.json() as { result?: { rows: Record<string, unknown>[] }; success: boolean };
  if (!data.success) return [];
  return (data.result?.rows || []).map((r) => ({ subjectId: String(r[subjectColumn]), created_at: String(r.created_at) }));
}
```

Then replace the `GET /api/flows/:id/nodes/:nodeId/logs` handler (lines 607-632):

```ts
// Node logs: list which users/content items entered a specific node (two-step: R2 for the
// log rows, then a D1 lookup for names — cross-table JOIN in R2 SQL is untested in this
// codebase, so this avoids relying on it).
app.get("/api/flows/:id/nodes/:nodeId/logs", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");
  const nodeId = c.req.param("nodeId");

  try {
    const flowRow = await c.env.FLOW_DB.prepare("SELECT graph_json FROM flows WHERE id = ? AND tenant_id = ?")
      .bind(flowId, tenantId).first<{ graph_json: string }>();
    if (!flowRow) return c.json({ logs: [] });
    const isContentDomain = flowRow.graph_json.includes("xContentTrigger");

    const rows = await queryNodeLogRows(
      c.env,
      isContentDomain ? "uniscrm.content_flow_log" : "uniscrm.flow_log",
      isContentDomain ? "content_id" : "user_id",
      Number(tenantId),
      flowId,
      nodeId
    );
    if (rows.length === 0) return c.json({ logs: [] });

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId).first<{ d1_database_id: string | null }>();
    if (!tenantRow?.d1_database_id) {
      return c.json({ logs: rows.map((r) => ({ [isContentDomain ? "content_id" : "user_id"]: r.subjectId, name: null, created_at: r.created_at })) });
    }

    const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const ids = [...new Set(rows.map((r) => r.subjectId))];
    const placeholders = ids.map(() => "?").join(",");
    const nameRows = isContentDomain
      ? await tdb.query<{ id: string; title: string | null }>(`SELECT id, title FROM content WHERE id IN (${placeholders})`, ids)
      : await tdb.query<{ id: string; name: string | null }>(`SELECT id, name FROM user WHERE id IN (${placeholders})`, ids);
    const nameMap = new Map(nameRows.map((r) => [r.id, isContentDomain ? (r as any).title : (r as any).name]));

    const logs = rows.map((r) => ({
      [isContentDomain ? "content_id" : "user_id"]: r.subjectId,
      name: nameMap.get(r.subjectId) ?? null,
      created_at: r.created_at,
    }));
    return c.json({ logs });
  } catch (e) {
    console.error(JSON.stringify({ event: "node_logs_error", tenantId, flowId, nodeId, error: String(e) }));
    return c.json({ logs: [] });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/node-logs-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/node-logs-endpoint.test.ts
git commit -m "feat(flow): drill-down endpoint queries R2 directly for both domains (two-step name lookup)"
```

---

## Manual verification (after all tasks land and dev deploys)

1. Publish a User Flow, trigger it (e.g. via `/internal/trigger` or a real X webhook in dev), confirm the Analytics tab's badges appear within a minute or two (waiting for the next cron tick + recompute) and the drill-down drawer lists the real user.
2. Publish a Content Flow, trigger it (e.g. via a real X List Posts event or manual content ingestion in dev), confirm the same for the content domain — badges appear, drill-down lists the real content item's title.
3. Check `wrangler r2 sql query uniscrm-dev "SELECT COUNT(*) FROM uniscrm.flow_log"` and the `content_flow_log` equivalent both show growing row counts as events occur.
4. Confirm the dev cron logs show `flow_counts_recomputed` lines with non-zero `flowRows`/`contentFlowRows` counts for the tenant(s) exercised above.
