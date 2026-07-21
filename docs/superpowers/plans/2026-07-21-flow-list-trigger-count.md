# Flow List "No. Triggered" — R2-Backed Cached Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flow list page's "No. Triggered" column read from the same R2-derived count the node-analytics drawer already uses (fixing a list-vs-drawer discrepancy), cached on `flows.trigger_count` for list-page performance; move `flow_counts`/`content_flow_counts` out of per-tenant D1 into the shared `flow` D1 db; delete the now-redundant `flow_executions`/`content_flow_executions` tables and their write path; add a single-trigger-node constraint to the flow editor.

**Architecture:** `recomputeFlowCounts()` (the existing once-a-minute cron job that aggregates `uniscrm.flow_log`/`uniscrm.content_flow_log` from R2) writes `flow_counts`/`content_flow_counts` directly into the shared `flow` D1 db instead of per-tenant over HTTP, and additionally caches each flow's trigger-node "entered" count onto a new `flows.trigger_count` column. `GET /api/flows` and `/api/flows/:id/analytics` both read from the shared db directly — no more per-tenant D1 HTTP round-trips. `flow_executions`/`content_flow_executions` (a second, independently-diverging counting mechanism) are deleted outright, including their write call sites and every test that depended on their row counts as an execution-completion signal.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2 SQL, Hono, Zustand (frontend store), Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- No production customer data is at risk: `flow_counts`/`content_flow_counts` are 0 rows in all 3 prod tenant dbs today (pure derived cache, fully repopulated by the next cron tick).
- `flows.trigger_count` starts `NULL` for every existing flow after migration; the frontend already renders `flow.trigger_count || "-"` (`flow/frontend/pages/FlowsPage.tsx:181`) — **no frontend change needed for this column**.
- Old per-tenant copies of `flow_counts`/`content_flow_counts`: remove from the new-tenant provisioning template only (`admin/src/services/tenant-init-sql.ts`). Do **not** write a migration to `DROP` them from the 3 existing prod tenant dbs — leave them in place, un-dropped, permanently unread.
- `flow/nodeTypeRegistry.ts`'s `NODE_TYPE_REGISTRY` (keyed by node `type` string, each entry has `role: "trigger" | "action" | "condition"`) is the single source of truth for "is this node type a trigger" on both the backend and frontend — never re-hardcode the four trigger type strings (`xTrigger`, `cronTrigger`, `xContentTrigger`, `youtubeContentTrigger`) as a separate list.
- Deleting `flow_executions`/`content_flow_executions` requires converting every test assertion that used their row counts as an execution-completion proxy signal to an equivalent `PIPELINE_CONTENT_FLOW_LOG.send`/`PIPELINE_FLOW_LOG.send` mock-based assertion — never just delete the assertion unless an equivalent check already exists elsewhere in the same test (see Task 5).
- This repo commits directly to `main` (no feature branches); only push to `origin` when explicitly told. Production Worker deploys happen via the repo's manual GitHub Actions workflow, never local `wrangler deploy --env production`.
- Verify migrations locally with `wrangler d1 execute <BINDING> --env dev --local --file=<path>` (the `--local` flag operates on a Miniflare-backed local sqlite file, never the real dev/prod D1) — do not run migrations against remote dev/prod D1 as part of this plan; that happens via the normal deploy pipeline.

---

### Task 1: Migration — drop old tables, create relocated tables, add cache column

**Files:**
- Create: `flow/migrations/0015_move_flow_counts_and_trigger_cache.sql`
- Modify: `admin/src/services/tenant-init-sql.ts:85-100`

**Interfaces:**
- Produces: `flow` D1 db tables `flow_counts(tenant_id, flow_id, node_id, direction, count, updated_at)` and `content_flow_counts` (same shape), primary key `(flow_id, node_id, direction)` on both; `flows.trigger_count INTEGER` (nullable) column. `flow_executions`/`content_flow_executions` no longer exist in the `flow` D1 db after this migration.

- [ ] **Step 1: Write the migration file**

Create `flow/migrations/0015_move_flow_counts_and_trigger_cache.sql`:

```sql
-- flow_executions/content_flow_executions' only reader (GET /api/flows' trigger_count) is
-- replaced by flows.trigger_count below, cached from the same R2-derived flow_counts/
-- content_flow_counts aggregation the node-analytics drawer already uses -- removing a second,
-- independently-diverging counting mechanism. See Task 5 for their write-side removal.
DROP TABLE IF EXISTS flow_executions;
DROP TABLE IF EXISTS content_flow_executions;

-- flow_counts/content_flow_counts move here from each tenant's own D1 database, where they had
-- no tenant_id column (relying on flow_id -- a UUID -- for uniqueness). Same primary key as
-- before; tenant_id added as a plain indexed column, matching the flow_executions/
-- content_flow_executions precedent this migration just dropped.
CREATE TABLE IF NOT EXISTS flow_counts (
  tenant_id INTEGER NOT NULL,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_flow_counts_tenant ON flow_counts(tenant_id);

CREATE TABLE IF NOT EXISTS content_flow_counts (
  tenant_id INTEGER NOT NULL,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_content_flow_counts_tenant ON content_flow_counts(tenant_id);

-- Cached "No. Triggered" value for the flow list page: the flow's one trigger node's
-- `direction = 'enter'` count -- the same source as the node-analytics drawer's "Entered" badge.
-- NULL until the next recomputeFlowCounts() cron tick (runs every minute) fills it in, or
-- permanently NULL if the flow has no recognized trigger node. The list page already renders
-- NULL as "-" (flow/frontend/pages/FlowsPage.tsx: `flow.trigger_count || "-"`) -- no frontend
-- change needed.
ALTER TABLE flows ADD COLUMN trigger_count INTEGER;
```

- [ ] **Step 2: Verify the migration applies cleanly to a local D1 replica**

From `flow/`, run:

```bash
wrangler d1 execute FLOW_DB --env dev --local --file=migrations/0015_move_flow_counts_and_trigger_cache.sql
```

Expected: command exits 0 with a success summary (e.g. `🌀 Executed N commands`). This runs
against a throwaway local Miniflare sqlite file (created fresh if it doesn't exist) — it does not
touch the real remote dev or prod D1 databases.

- [ ] **Step 3: Remove `flow_counts`/`content_flow_counts` from the new-tenant provisioning template**

In `admin/src/services/tenant-init-sql.ts`, delete these two array entries entirely (currently at
lines 85-100, immediately before the `content_trigger_dedup` entry which stays untouched):

```diff
   `CREATE INDEX IF NOT EXISTS idx_content_status ON content(status)`,
-  `CREATE TABLE IF NOT EXISTS flow_counts (
-    flow_id TEXT NOT NULL,
-    node_id TEXT NOT NULL,
-    direction TEXT NOT NULL,
-    count INTEGER NOT NULL,
-    updated_at TEXT NOT NULL,
-    PRIMARY KEY (flow_id, node_id, direction)
-  )`,
-  `CREATE TABLE IF NOT EXISTS content_flow_counts (
-    flow_id TEXT NOT NULL,
-    node_id TEXT NOT NULL,
-    direction TEXT NOT NULL,
-    count INTEGER NOT NULL,
-    updated_at TEXT NOT NULL,
-    PRIMARY KEY (flow_id, node_id, direction)
-  )`,
   `CREATE TABLE IF NOT EXISTS content_trigger_dedup (
```

- [ ] **Step 4: Run the admin test suite to confirm nothing else referenced these entries**

```bash
cd admin && npm test
```

Expected: all tests pass (no test in `admin/tests/` references `flow_counts`/`content_flow_counts`
or asserts on `TENANT_DB_INIT_SQL`'s array length — confirmed via
`grep -rln "tenant-init-sql\|TENANT_INIT_SQL\|flow_counts" admin/tests/` returning nothing).

- [ ] **Step 5: Commit**

```bash
git add flow/migrations/0015_move_flow_counts_and_trigger_cache.sql admin/src/services/tenant-init-sql.ts
git commit -m "feat(flow): migrate flow_counts/content_flow_counts into the shared flow db, add flows.trigger_count cache column"
```

---

### Task 2: `recomputeFlowCounts()` — write to FLOW_DB directly, cache `flows.trigger_count`

**Files:**
- Modify: `flow/src/index.ts` (imports at top; `recomputeFlowCounts` function, currently lines 138-182)
- Test: `flow/tests/unit/recompute-flow-counts.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY` from `flow/nodeTypeRegistry.ts` (already imported partially in `flow/src/index.ts:8` — add `NODE_TYPE_REGISTRY` to that same import), `CountRow` interface (existing, unchanged: `{ tenant_id, flow_id, node_id, direction, cnt }`), `queryR2Counts` (existing, unchanged).
- Produces: `recomputeFlowCounts(env: Env): Promise<void>` — same exported signature, now writes directly to `env.FLOW_DB` instead of per-tenant `TenantDataDB`, and additionally updates `flows.trigger_count`.

- [ ] **Step 1: Write the failing test (full rewrite of `recompute-flow-counts.test.ts`)**

Replace the entire contents of `flow/tests/unit/recompute-flow-counts.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { recomputeFlowCounts } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

const userFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const contentFlowGraph = JSON.stringify({ nodes: [{ id: "t1", type: "xContentTrigger", data: {}, position: { x: 0, y: 0 } }], edges: [] });
const triggerlessGraph = JSON.stringify({ nodes: [{ id: "a1", type: "action", data: { actionType: "noopLeaf" } }], edges: [] });

async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
       status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flow_counts (
       tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
       count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_counts (
       tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
       count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
     )`
  ).run();
}

describe("recomputeFlowCounts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setupSchema();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_counts`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_counts`).run();
    vi.unstubAllGlobals();
  });

  it("issues one query against uniscrm.flow_log and one against uniscrm.content_flow_log", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const queries = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).query);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.flow_log") && q.includes("GROUP BY"))).toBe(true);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.content_flow_log") && q.includes("GROUP BY"))).toBe(true);
  });

  it("upserts flow_counts/content_flow_counts directly into FLOW_DB, overwriting on conflict", async () => {
    fetchMock
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f1", node_id: "n1", direction: "enter", cnt: 5 },
      ]))
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f2", node_id: "n2", direction: "enter", cnt: 3 },
      ]));
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (1, 'f1', 'n1', 'enter', 1, '2020-01-01T00:00:00.000Z')`
    ).run();

    await recomputeFlowCounts(env as any);

    const flowRow = await env.FLOW_DB.prepare(`SELECT tenant_id, count FROM flow_counts WHERE flow_id = 'f1' AND node_id = 'n1' AND direction = 'enter'`).first<{ tenant_id: number; count: number }>();
    expect(flowRow).toMatchObject({ tenant_id: 1, count: 5 });
    const contentRow = await env.FLOW_DB.prepare(`SELECT tenant_id, count FROM content_flow_counts WHERE flow_id = 'f2' AND node_id = 'n2' AND direction = 'enter'`).first<{ tenant_id: number; count: number }>();
    expect(contentRow).toMatchObject({ tenant_id: 1, count: 3 });
  });

  it("caches the trigger node's enter count onto flows.trigger_count for a user-domain flow", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-u1', 1, 'u', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(userFlowGraph).run();
    fetchMock
      .mockResolvedValueOnce(mockR2Response([{ tenant_id: 1, flow_id: "flow-u1", node_id: "t1", direction: "enter", cnt: 42 }]))
      .mockResolvedValueOnce(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-u1'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBe(42);
  });

  it("caches the trigger node's enter count onto flows.trigger_count for a content-domain flow", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-c1', 1, 'c', ?, 'content', 'published', datetime('now'), datetime('now'))`
    ).bind(contentFlowGraph).run();
    fetchMock
      .mockResolvedValueOnce(mockR2Response([]))
      .mockResolvedValueOnce(mockR2Response([{ tenant_id: 1, flow_id: "flow-c1", node_id: "t1", direction: "enter", cnt: 7 }]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-c1'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBe(7);
  });

  it("leaves trigger_count NULL for a flow with no recognized trigger node", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-none', 1, 'n', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(triggerlessGraph).run();
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-none'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBeNull();
  });

  it("leaves trigger_count NULL for a flow whose trigger node has no R2 activity yet", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('flow-quiet', 1, 'q', ?, 'user', 'published', datetime('now'), datetime('now'))`
    ).bind(userFlowGraph).run();
    fetchMock.mockResolvedValue(mockR2Response([]));

    await recomputeFlowCounts(env as any);

    const row = await env.FLOW_DB.prepare(`SELECT trigger_count FROM flows WHERE id = 'flow-quiet'`).first<{ trigger_count: number | null }>();
    expect(row?.trigger_count).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd flow && npx vitest run tests/unit/recompute-flow-counts.test.ts
```

Expected: FAIL — the old `recomputeFlowCounts` still calls `env.WEB_DB.prepare("SELECT
d1_database_id FROM tenants...")` and `TenantDataDB`, neither of which this test's `env` (real
`cloudflare:test` D1 bindings, no `WEB_DB.tenants` row, no `TenantDataDB` mock) supports the same
way — count rows and `trigger_count` will not appear in `FLOW_DB` at all.

- [ ] **Step 3: Rewrite `recomputeFlowCounts`**

In `flow/src/index.ts`, first add `NODE_TYPE_REGISTRY` to the existing nodeTypeRegistry import
(line 8):

```diff
-import { CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../nodeTypeRegistry";
+import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, NODE_TYPE_REGISTRY } from "../nodeTypeRegistry";
```

Then replace the entire `recomputeFlowCounts` function (currently lines 138-182) with:

```ts
export async function recomputeFlowCounts(env: Env): Promise<void> {
  const [flowRows, contentFlowRows] = await Promise.all([
    queryR2Counts(env, "uniscrm.flow_log"),
    queryR2Counts(env, "uniscrm.content_flow_log"),
  ]);

  const now = new Date().toISOString();
  const allRows = [...flowRows, ...contentFlowRows];

  for (const r of flowRows) {
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(flow_id, node_id, direction) DO UPDATE SET tenant_id = excluded.tenant_id, count = excluded.count, updated_at = excluded.updated_at`
    ).bind(r.tenant_id, r.flow_id, r.node_id, r.direction, r.cnt, now).run();
  }
  for (const r of contentFlowRows) {
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(flow_id, node_id, direction) DO UPDATE SET tenant_id = excluded.tenant_id, count = excluded.count, updated_at = excluded.updated_at`
    ).bind(r.tenant_id, r.flow_id, r.node_id, r.direction, r.cnt, now).run();
  }

  // Cache each flow's trigger-node "entered" count directly on flows.trigger_count, so the list
  // page's GET /api/flows can read it as a plain column with no per-request join, R2 call, or
  // tenant-db round-trip. "enter" rows for both domains are already in allRows above.
  const enterCountByFlowNode = new Map<string, number>();
  for (const r of allRows) {
    if (r.direction === "enter") enterCountByFlowNode.set(`${r.flow_id}:${r.node_id}`, r.cnt);
  }

  const flows = await env.FLOW_DB.prepare(`SELECT id, graph_json FROM flows`).all<{ id: string; graph_json: string }>();
  for (const flow of flows.results) {
    let triggerNodeId: string | undefined;
    try {
      const graph = JSON.parse(flow.graph_json) as { nodes: { id: string; type: string }[] };
      triggerNodeId = graph.nodes.find((n) => NODE_TYPE_REGISTRY[n.type]?.role === "trigger")?.id;
    } catch {
      continue;
    }
    if (!triggerNodeId) continue;
    const count = enterCountByFlowNode.get(`${flow.id}:${triggerNodeId}`);
    if (count === undefined) continue;
    await env.FLOW_DB.prepare(`UPDATE flows SET trigger_count = ? WHERE id = ?`).bind(count, flow.id).run();
  }

  console.log(JSON.stringify({ event: "flow_counts_recomputed", flowRows: flowRows.length, contentFlowRows: contentFlowRows.length }));
}
```

Note: `TenantDataDB` stays imported at the top of `flow/src/index.ts` — it is still used by other,
unrelated endpoints (e.g. the `xAction` `userPropsFilter` check). Do not remove that import in this
task.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd flow && npx vitest run tests/unit/recompute-flow-counts.test.ts
```

Expected: `Test Files 1 passed (1)`, all 6 tests passing.

- [ ] **Step 5: Run the full flow suite**

```bash
cd flow && npm test
```

Expected: no new failures beyond whatever pre-existing state the suite was in before this task
(the `analytics-endpoint.test.ts`/`flows-list.test.ts` failures expected here are addressed by
Tasks 3-4, not this one — confirm any failing tests at this point are only in those two files).

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/recompute-flow-counts.test.ts
git commit -m "feat(flow): recomputeFlowCounts writes flow_counts/content_flow_counts to FLOW_DB directly, caches flows.trigger_count"
```

---

### Task 3: `/api/flows/:id/analytics` — read `flow_counts`/`content_flow_counts` from FLOW_DB

**Files:**
- Modify: `flow/src/index.ts` (`app.get("/api/flows/:id/analytics", ...)`, currently lines 1296-1327)
- Test: `flow/tests/unit/analytics-endpoint.test.ts`

**Interfaces:**
- Consumes: `isContentDomainFlow` (existing, unchanged).
- Produces: same route, same response shape `{ nodes: Record<string, { enter: number; exit: number }>> }`.

- [ ] **Step 1: Update the failing test**

In `flow/tests/unit/analytics-endpoint.test.ts`:

1. Remove the `fetchMock` entirely — this endpoint no longer calls `fetch` for anything (no more
   `/api/auth/me` tenant lookup via HTTP for `d1_database_id`, no more `TenantDataDB` REST call).
   Note `/api/auth/me` here was never actually about *this* endpoint's own auth (that's
   `authMiddleware`, applied globally) — re-check: `authMiddleware` still calls `fetch` for session
   lookup regardless of this task, so **keep** a `fetchMock` that resolves `/api/auth/me`, just
   delete the `d1QueryResponse` helper and the "Tenant D1 REST query" fallback branch, since no
   other `fetch` call happens now:

```diff
-function d1QueryResponse(rows: Record<string, unknown>[]) {
-  return new Response(JSON.stringify({ success: true, result: [{ results: rows, success: true, meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 } }] }), { status: 200 });
-}
-
 describe("GET /api/flows/:id/analytics", () => {
   let fetchMock: ReturnType<typeof vi.fn>;

   beforeEach(async () => {
     fetchMock = vi.fn(async (url: string) => {
-      if (String(url).includes("/api/auth/me")) {
-        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
-      }
-      // Tenant D1 REST query — the specific rows returned don't matter for this task's
-      // table-selection assertions, an empty result set is enough.
-      return d1QueryResponse([]);
+      return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
     });
     vi.stubGlobal("fetch", fetchMock);
```

2. The `beforeEach` currently creates `flows` and `tenants` tables but never `flow_counts`/
   `content_flow_counts` (they used to live in a tenant D1 reached only via the mocked HTTP call).
   Add both table creations, plus seed rows for the assertions below, right after the existing
   `flows`/`tenants` setup and the `env.FLOW_DB.batch([...])` insert of the four flow fixtures:

```ts
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flow_counts (
         tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
         count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
       )`
    ).run();
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_flow_counts (
         tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
         count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
       )`
    ).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, 'flow-an-user', 't1', 'enter', 9, datetime('now'))`
      ).bind(TENANT_ID),
      env.FLOW_DB.prepare(
        `INSERT INTO content_flow_counts (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, 'flow-an-content', 't1', 'enter', 4, datetime('now'))`
      ).bind(TENANT_ID),
    ]);
```

3. Add matching cleanup to `afterEach`:

```diff
   afterEach(async () => {
     await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
+    await env.FLOW_DB.prepare(`DELETE FROM flow_counts WHERE tenant_id = ?`).bind(TENANT_ID).run();
+    await env.FLOW_DB.prepare(`DELETE FROM content_flow_counts WHERE tenant_id = ?`).bind(TENANT_ID).run();
     await env.WEB_DB.prepare(`DELETE FROM tenants WHERE tenant_id = ?`).bind(TENANT_ID).run();
     vi.unstubAllGlobals();
   });
```

4. Replace all five `it(...)` bodies — they currently inspect `fetchMock.mock.calls` for the SQL
   sent to the tenant D1 REST endpoint. Replace each with a direct assertion on the JSON response's
   `nodes` shape instead:

```ts
  it("returns the cached flow_counts row for a user-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-user/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, { enter: number; exit: number }> };
    expect(body.nodes).toEqual({ t1: { enter: 9, exit: 0 } });
  });

  it("returns the cached content_flow_counts row for a content-domain flow", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-content/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, { enter: number; exit: number }> };
    expect(body.nodes).toEqual({ t1: { enter: 4, exit: 0 } });
  });

  it("queries content_flow_counts for a YouTube-only content flow (no xContentTrigger substring)", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-youtube/analytics"), env);
    expect(res.status).toBe(200);
    // No seeded rows for this flow -- empty nodes is still a 200, proving it read
    // content_flow_counts (not flow_counts) without erroring.
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });

  it("queries content_flow_counts for a content flow whose only trigger was deleted", async () => {
    const res = await worker.fetch(req("/api/flows/flow-an-triggerless/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });

  it("returns { nodes: {} } for a flow id that doesn't exist for this tenant", async () => {
    const res = await worker.fetch(req("/api/flows/flow-nonexistent/analytics"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Record<string, unknown> };
    expect(body.nodes).toEqual({});
  });
```

(Delete the old `"queries flow_counts for a user-domain flow"` test — it's superseded by the first
new test above, which asserts the actual returned data instead of the outbound SQL string.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd flow && npx vitest run tests/unit/analytics-endpoint.test.ts
```

Expected: FAIL — the current handler still calls `WEB_DB` for `d1_database_id` and `TenantDataDB`,
neither of which the updated test's `fetchMock` (now only resolving `/api/auth/me`) supports; the
seeded `flow_counts`/`content_flow_counts` rows in `FLOW_DB` are never read.

- [ ] **Step 3: Rewrite the endpoint**

Replace the body of `app.get("/api/flows/:id/analytics", ...)` (currently lines 1296-1327) with:

```ts
app.get("/api/flows/:id/analytics", async (c) => {
  const flowId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const isContentDomain = await isContentDomainFlow(c.env, flowId, tenantId);
  if (isContentDomain === null) return c.json({ nodes: {} });
  const table = isContentDomain ? "content_flow_counts" : "flow_counts";

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT node_id, direction, count FROM ${table} WHERE tenant_id = ? AND flow_id = ?`
  ).bind(Number(tenantId), flowId).all<{ node_id: string; direction: string; count: number }>();

  const nodes: Record<string, { enter: number; exit: number }> = {};
  for (const r of rows.results) {
    if (!nodes[r.node_id]) nodes[r.node_id] = { enter: 0, exit: 0 };
    if (r.direction === "enter") nodes[r.node_id].enter = r.count;
    if (r.direction === "exit") nodes[r.node_id].exit = r.count;
  }
  return c.json({ nodes });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd flow && npx vitest run tests/unit/analytics-endpoint.test.ts
```

Expected: `Test Files 1 passed (1)`, all 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/analytics-endpoint.test.ts
git commit -m "feat(flow): read node-analytics counts from FLOW_DB directly, drop the per-tenant D1 HTTP round-trip"
```

---

### Task 4: `GET /api/flows` — select `flows.trigger_count` directly

**Files:**
- Modify: `flow/src/index.ts` (`app.get("/api/flows", ...)`, currently lines 1132-1169)
- Test: `flow/tests/unit/flows-list.test.ts`

**Interfaces:**
- Produces: same route, same response shape; `trigger_count` is now `number | null` (was always
  `number` before, since the old subquery-sum could never be NULL).

- [ ] **Step 1: Update the failing test**

In `flow/tests/unit/flows-list.test.ts`:

1. Remove the `flow_executions`/`content_flow_executions` `CREATE TABLE IF NOT EXISTS` blocks from
   `beforeEach` (lines 52-73) — the rewritten query no longer references either table:

```diff
     await env.FLOW_DB.prepare(
       `CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY,
          tenant_id INTEGER NOT NULL,
          member_id TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL DEFAULT 'Untitled Flow',
          description TEXT DEFAULT '',
          graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
          domain TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'draft',
+         trigger_count INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
     ).run();
-    await env.FLOW_DB.prepare(
-      `CREATE TABLE IF NOT EXISTS flow_executions (
-         id TEXT PRIMARY KEY,
-         flow_id TEXT NOT NULL,
-         event_id TEXT,
-         user_id TEXT NOT NULL,
-         tenant_id INTEGER NOT NULL,
-         matched INTEGER NOT NULL DEFAULT 1,
-         created_at TEXT NOT NULL
-       )`
-    ).run();
-    await env.FLOW_DB.prepare(
-      `CREATE TABLE IF NOT EXISTS content_flow_executions (
-         id TEXT PRIMARY KEY,
-         flow_id TEXT NOT NULL,
-         event_id TEXT,
-         content_id TEXT NOT NULL,
-         tenant_id INTEGER NOT NULL,
-         matched INTEGER NOT NULL DEFAULT 1,
-         created_at TEXT NOT NULL
-       )`
-    ).run();
```

2. Update the two seeded flow inserts (`f-user`, `f-content`) to set an explicit `trigger_count`,
   and add a new test asserting it round-trips through the response:

```diff
     await env.FLOW_DB.batch([
       env.FLOW_DB.prepare(
-        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('f-user', ?, 'u', ?, 'user', 'draft', datetime('now'), datetime('now'))`
+        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, trigger_count, created_at, updated_at) VALUES ('f-user', ?, 'u', ?, 'user', 'draft', 11, datetime('now'), datetime('now'))`
       ).bind(TENANT_ID, userFlowGraph),
       env.FLOW_DB.prepare(
-        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at) VALUES ('f-content', ?, 'c', ?, 'content', 'draft', datetime('now'), datetime('now'))`
+        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, trigger_count, created_at, updated_at) VALUES ('f-content', ?, 'c', ?, 'content', 'draft', NULL, datetime('now'), datetime('now'))`
       ).bind(TENANT_ID, contentFlowGraph),
     ]);
```

3. Add a new test, right after `"domain=user (default) returns only the user-domain flow"`:

```ts
  it("returns the cached trigger_count column, null when not yet computed", async () => {
    const res = await worker.fetch(req("/api/flows"), env);
    const body = await res.json() as { flows: { id: string; trigger_count: number | null }[] };
    expect(body.flows.find((f) => f.id === "f-user")?.trigger_count).toBe(11);

    const contentRes = await worker.fetch(req("/api/flows?domain=content"), env);
    const contentBody = await contentRes.json() as { flows: { id: string; trigger_count: number | null }[] };
    expect(contentBody.flows.find((f) => f.id === "f-content")?.trigger_count).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd flow && npx vitest run tests/unit/flows-list.test.ts
```

Expected: FAIL — the current query still sums `flow_executions`/`content_flow_executions` (tables
this test no longer creates), so the request errors instead of returning `trigger_count: 11`.

- [ ] **Step 3: Rewrite the query**

In `flow/src/index.ts`, replace lines 1146-1152:

```diff
   const rows = await c.env.FLOW_DB.prepare(
-    `SELECT f.id, f.name, f.description, f.status, f.member_id, f.created_at, f.updated_at,
-       (SELECT COUNT(*) FROM flow_executions WHERE flow_id = f.id) + (SELECT COUNT(*) FROM content_flow_executions WHERE flow_id = f.id) as trigger_count
-     FROM flows f WHERE f.tenant_id = ? AND f.domain = ? ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`
+    `SELECT f.id, f.name, f.description, f.status, f.member_id, f.created_at, f.updated_at, f.trigger_count
+     FROM flows f WHERE f.tenant_id = ? AND f.domain = ? ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`
   )
     .bind(tenantId, domain, limit, offset)
-    .all<{ id: string; name: string; description: string; status: string; member_id: string; created_at: string; updated_at: string; trigger_count: number }>();
+    .all<{ id: string; name: string; description: string; status: string; member_id: string; created_at: string; updated_at: string; trigger_count: number | null }>();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd flow && npx vitest run tests/unit/flows-list.test.ts
```

Expected: `Test Files 1 passed (1)`, all 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/flows-list.test.ts
git commit -m "feat(flow): GET /api/flows reads the cached trigger_count column instead of summing flow_executions/content_flow_executions"
```

---

### Task 5: Delete `flow_executions`/`content_flow_executions` write path

**Files:**
- Modify: `flow/src/index.ts` (~21 standalone `INSERT INTO (content_)?flow_executions` statements)
- Test: `flow/tests/unit/emit-node-logs.test.ts`, `flow/tests/unit/emit-content-node-logs.test.ts`, `flow/tests/unit/content-action-branch-node-logs.test.ts`, `flow/tests/unit/video-action-resume.test.ts`, `flow/tests/unit/queue-content.test.ts`, `flow/tests/unit/scheduled-content.test.ts`

**Context:** This is one atomic task, not splittable across commits — removing the write code
first would break every test in the six files above (they'd query a table whose rows never
appear); updating the tests first would leave them asserting against tables the production code
still writes to. Land both halves together.

**Interfaces:**
- Consumes: nothing new.
- Produces: `flow/src/index.ts` no longer contains the strings `flow_executions` or
  `content_flow_executions` anywhere (verify via `grep -n "flow_executions" flow/src/index.ts`
  returning nothing after this task).

- [ ] **Step 1: Remove every write call site in `flow/src/index.ts`**

Run this to enumerate every occurrence before starting:

```bash
cd flow && grep -n "flow_executions\|content_flow_executions" src/index.ts
```

Every one of these ~21 occurrences (as of this plan's writing: lines 414, 471, 517, 547, 595, 650,
688, 732, 760, 804, 899, 945, 1500, 1551, 1621, 1666, 1730, 1774, 1824, 1905 — line numbers will
have shifted after Tasks 1-4's edits, re-run the grep to get current ones) is a standalone
statement of this exact shape, always immediately following an `if (resumed.actions.length > 0)`
(or equivalent) block, with no other side effect bundled into it:

```ts
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
```

or, for the user-domain table:

```ts
        c.env.FLOW_DB.prepare("INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at) VALUES (?, ?, ?, ?, 1, ?)")
```

Delete each occurrence's entire statement (from `await env.FLOW_DB.prepare(` or
`env.FLOW_DB.prepare(` through the closing `.run();`) — nothing else on the surrounding lines
changes. After deleting all of them, re-run the grep above and confirm it returns nothing.

- [ ] **Step 2: Update the four "boilerplate-only" test files**

These files never assert on `flow_executions`/`content_flow_executions` row counts — the
`CREATE TABLE`/`DELETE FROM` statements referencing them exist purely because the code under test
used to write to them. Delete just those statements; leave every `it(...)` body unchanged.

`flow/tests/unit/emit-node-logs.test.ts`: delete the `CREATE TABLE IF NOT EXISTS flow_executions`
block (lines 30-35) and the `afterEach`'s `DELETE FROM flow_executions...` line (line 44).

`flow/tests/unit/emit-content-node-logs.test.ts`: delete the `CREATE TABLE IF NOT EXISTS
content_flow_executions` block (lines 30-35) and the `afterEach`'s `DELETE FROM
content_flow_executions...` line (line 53).

`flow/tests/unit/content-action-branch-node-logs.test.ts`: delete the `CREATE TABLE IF NOT EXISTS
content_flow_executions` block inside `setupSchema()` (lines 56-61) and both `afterEach`'s
`DELETE FROM content_flow_executions...` lines (76, 147).

`flow/tests/unit/video-action-resume.test.ts`: delete the `CREATE TABLE IF NOT EXISTS
content_flow_executions` block inside `setupSchema()` (lines 58-63). Then, in the "deletes the
pending row and resumes the success branch" test, delete these lines (130-133, 136) — the
`pipelineSend` assertion three lines above already proves a2's enter+exit fired, making this a
redundant second check of the same fact via a different mechanism:

```diff
-    const exec = await env.FLOW_DB.prepare(
-      `SELECT content_id FROM content_flow_executions WHERE flow_id = 'flow-resume-1'`
-    ).first<{ content_id: string }>();
-    expect(exec).toMatchObject({ content_id: "content-resume-1" });
-
     await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-resume-1'`).run();
-    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-resume-1'`).run();
```

- [ ] **Step 3: Convert `queue-content.test.ts`'s substantive assertions**

Delete the `CREATE TABLE IF NOT EXISTS flow_executions`/`content_flow_executions` blocks from the
top-level `beforeEach` (lines 46-67) and every `DELETE FROM (content_)?flow_executions` cleanup
line throughout the file.

The two tests in the first `describe` block that directly assert on these tables' rows
(`"matches a published flow with an xContentTrigger and records content_flow_executions keyed by
content_id"`, `"does not touch flow_executions..."`) are now meaningless (they tested the exact
write path just deleted) — delete both tests entirely; Task 4's `flows-list.test.ts` and this
file's own `pipelineSend`-based tests already cover "a content trigger match happened" from the
node-log-emission angle.

For every remaining `SELECT COUNT(*) ... FROM content_flow_executions` assertion (the branch-
resolution and video-action tests), replace the row-count check with a `PIPELINE_CONTENT_FLOW_LOG`
mock capturing the emitted records, following the pattern already established in
`content-action-branch-node-logs.test.ts`. Worked example for the two tests at (pre-Task-5) lines
168-203 — "resolves the success branch and runs a2 when link returns ok:true" /"...failed branch
when link returns ok:false":

```diff
   it("resolves the success branch and runs a2 when link returns ok:true", async () => {
     vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

+    const pipelineSend = vi.fn().mockResolvedValue(undefined);
+    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
     await worker.queue(
       makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-1", channelId: "src-chan", payload: {} }),
-      env
+      testEnv as any
     );

-    // What we're actually asserting here is that resumeFromNode fired at all (a second
-    // content_flow_executions row was recorded for the resumed action) after the fetch resolved.
-    // ...
-    const rows = await env.FLOW_DB.prepare(
-      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
-    ).first<{ c: number }>();
-    expect(rows?.c).toBeGreaterThanOrEqual(2);
+    // resumeFromNode resolved a1's "success" branch down to a2 -- the second pipelineSend call
+    // (the first is the initial t1/a1 dispatch) carries a2's enter+exit.
+    expect(pipelineSend).toHaveBeenCalledTimes(2);
+    const [, secondCallRecords] = pipelineSend.mock.calls.map((c: any[]) => c[0]);
+    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);
   });

   it("resolves the failed branch when link returns ok:false", async () => {
     vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 502 })));

+    const pipelineSend = vi.fn().mockResolvedValue(undefined);
+    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
     await worker.queue(
       makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-2", channelId: "src-chan", payload: {} }),
-      env
+      testEnv as any
     );

-    const rows = await env.FLOW_DB.prepare(
-      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
-    ).first<{ c: number }>();
-    expect(rows?.c).toBeGreaterThanOrEqual(2);
+    expect(pipelineSend).toHaveBeenCalledTimes(2);
+    const [, secondCallRecords] = pipelineSend.mock.calls.map((c: any[]) => c[0]);
+    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
   });
```

Apply the same `pipelineSend`-capture-and-assert-on-records pattern to the video-condition tests
later in the file (the "calls content's /internal/detect-face..." / "resumes on the no-face
branch..." / "resumes on the failed branch when content's /internal/detect-face returns a non-2xx"
tests). The third of these is the trickiest case — read it carefully before converting: neither
`a2` nor `a3` is wired to a "failed" edge in that test's graph, so resolving "failed" reaches no
downstream node at all. `resumed.nodeLogs` in that case is exactly `[a1's relabeled outcome entry]`
(non-empty — `emitContentNodeLogs` still fires), but `resumed.actions` is empty (no nested
action). Convert its old `expect(rows?.c).toBe(1)` assertion to:

```ts
    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
    // (pass testEnv to the worker.queue(...) call above instead of env)

    expect(pipelineSend).toHaveBeenCalledTimes(2);
    const [, secondCallRecords] = pipelineSend.mock.calls.map((c: any[]) => c[0]);
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome"]);
    expect(secondCallRecords[0].outcome).toBe("failed");
```

This is a strictly more precise assertion than the row count it replaces — it proves the exact
resolved outcome value, not just "some non-branch-following state," and proves nothing further
executed (the array has no second/third entry).

Convert the remaining `SELECT COUNT(*) ... content_flow_executions` assertions in this file (the
video/tiktok pending-retry tests further down) using the same rule: add a `pipelineSend` mock,
pass it via `testEnv`, and assert the mock's records show the expected downstream node's
`enter`/`exit` (or bare `outcome` for a dead branch) instead of counting rows.

- [ ] **Step 4: Convert `scheduled-content.test.ts`'s substantive assertions**

Delete the `CREATE TABLE IF NOT EXISTS content_flow_executions` block from `beforeEach` (lines
58-68) and every `DELETE FROM content_flow_executions` cleanup line.

The test "resumes a due content_flow_pending row via resumeFromNode and clears it" (lines 93-114)
has no `pipelineSend` mock today — add one and assert on the emitted records instead of the row:

```diff
-    await worker.scheduled({} as any, env);
+    const pipelineSend = vi.fn().mockResolvedValue(undefined);
+    const testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } };
+    await worker.scheduled({} as any, testEnv as any);

     const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-1'`).first();
     expect(remaining).toBeNull();

-    const exec = await env.FLOW_DB.prepare(
-      `SELECT content_id FROM content_flow_executions WHERE flow_id = 'flow-c2'`
-    ).first<{ content_id: string }>();
-    expect(exec).toMatchObject({ content_id: "content-abc" });
+    // w1 is a "wait" node -- its own exit is not eagerly logged at dispatch time, so resuming it
+    // emits its real exit (not relabeled to "outcome"), followed by a1's genuine enter+exit.
+    expect(pipelineSend).toHaveBeenCalledTimes(1);
+    const [records] = pipelineSend.mock.calls[0];
+    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["w1:exit", "a1:enter", "a1:exit"]);
```

The test at (pre-Task-5) lines 137-171 ("a timed-out videoAction pending row resumes the 'failed'
branch, not 'no'") already has a `pipelineSend` mock and asserts on its records — only its trailing
`content_flow_executions` SELECT (lines 167-170) needs deleting, nothing else in that test changes:

```diff
     expect(records[0].outcome).toBe("failed");
-
-    const exec = await env.FLOW_DB.prepare(
-      `SELECT content_id FROM content_flow_executions WHERE flow_id = 'flow-c2' AND content_id = 'content-vaction-1'`
-    ).first<{ content_id: string }>();
-    expect(exec).toMatchObject({ content_id: "content-vaction-1" });
   });
```

For the remaining four tests using `SELECT COUNT(*) ... FROM content_flow_executions ...
toBeGreaterThanOrEqual(1)` (the retry-handling and xVideoStatusPoll describe blocks, at
pre-Task-5 lines 221-243, 245-272, 297-325, 327-348, 372-393): each needs a `pipelineSend` mock
added (none currently capture one in these blocks) and its assertion converted from a row count to
checking the mock was called with the expected downstream node's records, following the same
`testEnv = { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } }` /
`await worker.scheduled({} as any, testEnv as any)` pattern shown above. Match each test's expected
downstream node to the branch its own graph fixture and stubbed response resolve to (e.g. the
"resolves the branch and clears the row once no longer rate-limited" test resolves the "success"
branch of `graphWithBranches` down to `a2`, so its records should equal `["a1:outcome", "a2:enter",
"a2:exit"]` with `outcome: "success"`).

- [ ] **Step 5: Run the full flow suite**

```bash
cd flow && npm test
```

Expected: all tests pass, and `grep -rn "flow_executions" flow/src/index.ts flow/tests/unit/`
returns nothing (both the table names and every reference to them are gone from source and
tests).

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/emit-node-logs.test.ts flow/tests/unit/emit-content-node-logs.test.ts flow/tests/unit/content-action-branch-node-logs.test.ts flow/tests/unit/video-action-resume.test.ts flow/tests/unit/queue-content.test.ts flow/tests/unit/scheduled-content.test.ts
git commit -m "refactor(flow): delete flow_executions/content_flow_executions write path, convert dependent tests to assert on emitted pipeline records"
```

---

### Task 6: Single-trigger-node editor constraint

**Files:**
- Modify: `flow/frontend/store/flow-editor.ts` (`FlowEditorState.addNode` signature and implementation)
- Modify: `flow/frontend/components/Canvas.tsx` (`onDrop` handler — show a toast on rejection)
- Test: `flow/tests/unit/single-trigger-constraint.test.ts` (new)

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY` from `../../nodeTypeRegistry` (already imported in
  `flow-editor.ts:13` — add `NODE_TYPE_REGISTRY` to that same import).
- Produces: `addNode: (type: string, position: { x: number; y: number }) => boolean` — return type
  changes from `void` to `boolean` (`true` if the node was added, `false` if rejected). Existing
  callers that ignore the return value (`Canvas.tsx`'s `onDrop`, `EditorPage.tsx`'s
  `useFlowEditor.getState().addNode("xContentTrigger", ...)` on a fresh empty canvas) are
  unaffected by this signature widening.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/single-trigger-constraint.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useFlowEditor } from "../../frontend/store/flow-editor";

describe("addNode: single-trigger-node constraint", () => {
  beforeEach(() => {
    useFlowEditor.setState({ nodes: [], edges: [], isDirty: false });
  });

  it("adds the first trigger node normally", () => {
    const added = useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    expect(added).toBe(true);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
    expect(useFlowEditor.getState().nodes[0].type).toBe("xTrigger");
  });

  it("rejects adding a second trigger node of the same type", () => {
    useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("xTrigger", { x: 100, y: 0 });
    expect(added).toBe(false);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
  });

  it("rejects adding a second trigger node of a different type", () => {
    useFlowEditor.getState().addNode("xContentTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("youtubeContentTrigger", { x: 100, y: 0 });
    expect(added).toBe(false);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
  });

  it("still allows adding non-trigger nodes freely alongside an existing trigger", () => {
    useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("wait", { x: 100, y: 0 });
    expect(added).toBe(true);
    expect(useFlowEditor.getState().nodes).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd flow && npx vitest run tests/unit/single-trigger-constraint.test.ts
```

Expected: FAIL on the second and third tests (`added` is `undefined`, not `false`, and both nodes
get added — `nodes` has length 2, not 1) — `addNode` has no constraint today.

- [ ] **Step 3: Implement the constraint**

In `flow/frontend/store/flow-editor.ts`, add `NODE_TYPE_REGISTRY` to the existing import:

```diff
-import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, type FlowDomain } from "../../nodeTypeRegistry";
+import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, NODE_TYPE_REGISTRY, type FlowDomain } from "../../nodeTypeRegistry";
```

Update the `addNode` signature in the `FlowEditorState` interface:

```diff
-  addNode: (type: string, position: { x: number; y: number }) => void;
+  addNode: (type: string, position: { x: number; y: number }) => boolean;
```

Update the `addNode` implementation — add the guard at the very top of the function body, and
return `true`/`false` at the appropriate points:

```diff
   addNode: (type, position) => {
+    if (NODE_TYPE_REGISTRY[type]?.role === "trigger" && get().nodes.some((n) => NODE_TYPE_REGISTRY[n.type!]?.role === "trigger")) {
+      return false;
+    }
+
     let nodeType: string;
     let data: Record<string, unknown>;

     if (type === "xTrigger") {
```

...and at the bottom of the function, after the existing `set((state) => ({ nodes: [...state.nodes, node], isDirty: true }));`:

```diff
     set((state) => ({ nodes: [...state.nodes, node], isDirty: true }));

     if (ACTION_CHANNEL_TYPE[type]) {
       void get().autoFillChannelIds();
     }
+    return true;
   },
```

Also update the early-return `else { return; }` branch (the unrecognized-type fallthrough,
currently plain `return;`) to `return false;`:

```diff
     } else {
-      return;
+      return false;
     }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd flow && npx vitest run tests/unit/single-trigger-constraint.test.ts
```

Expected: `Test Files 1 passed (1)`, all 4 tests passing.

- [ ] **Step 5: Show a toast when a drag-and-drop add is rejected**

In `flow/frontend/components/Canvas.tsx`, add the toast import and use it in `onDrop`:

```diff
 import { useCallback, useRef } from "react";
 import {
   ReactFlow,
   Background,
   Controls,
   Panel,
   useReactFlow,
   type ReactFlowInstance,
   type Edge,
   type Connection,
   type Node,
 } from "@xyflow/react";
 import dagre from "@dagrejs/dagre";
 import { useFlowEditor, isValidConnection as isValidNodeConnection } from "../store/flow-editor";
 import { Button } from "../../../shared/frontend/ui/button";
+import { useToast } from "../../../shared/frontend/hooks/use-toast";
 import DeletableEdge from "../edges/DeletableEdge";

 const edgeTypes = { default: DeletableEdge };
 import { nodeTypes } from "../nodes";

 export default function Canvas() {
   const reactFlowRef = useRef<ReactFlowInstance | null>(null);
   const { nodes, edges, errorNodeIds, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode } =
     useFlowEditor();
+  const { toast } = useToast();

   const onDragOver = useCallback((e: React.DragEvent) => {
     e.preventDefault();
     e.dataTransfer.dropEffect = "move";
   }, []);

   const onDrop = useCallback(
     (e: React.DragEvent) => {
       e.preventDefault();
       const type = e.dataTransfer.getData("application/reactflow-type");
       if (!type || !reactFlowRef.current) return;

       const position = reactFlowRef.current.screenToFlowPosition({
         x: e.clientX,
         y: e.clientY,
       });
-      addNode(type, position);
+      const added = addNode(type, position);
+      if (!added) {
+        toast({ title: "一个流程只能有一个触发节点", variant: "destructive" });
+      }
     },
-    [addNode]
+    [addNode, toast]
   );
```

- [ ] **Step 6: Run the full flow suite**

```bash
cd flow && npm test
```

Expected: all tests pass, including the 4 new ones from this task.

- [ ] **Step 7: Commit**

```bash
git add flow/frontend/store/flow-editor.ts flow/frontend/components/Canvas.tsx flow/tests/unit/single-trigger-constraint.test.ts
git commit -m "feat(flow editor): reject adding a second trigger node to a flow's graph"
```

---

## Final Verification

After all 6 tasks:

```bash
cd flow && npm test
```

Expected: full suite green, and:

```bash
grep -rn "flow_executions" flow/src flow/tests flow/migrations
```

Expected: only hits inside `flow/migrations/0015_move_flow_counts_and_trigger_cache.sql`'s `DROP
TABLE IF EXISTS` lines and this plan's own commit messages — no live code or test references
remain.

Then verify locally in dev per the project's usual flow: `wrangler deploy --env dev` from `flow/`,
open the flow list page in a browser, and confirm the "No. Triggered" column still renders (will
show "-" for every existing flow until the next `recomputeFlowCounts()` cron tick populates
`trigger_count`, and further until R2 has fresh trigger data for those flows — this is expected,
not a regression, per this plan's Global Constraints).

Production Worker deploy is out of scope for this plan's execution — defer to the repo's manual
GitHub Actions "Deploy Production" workflow, which will also pick up the still-pending
`0014_flows_domain.sql` migration alongside this plan's `0015_...sql`.
