# Content R2 Data Catalog Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 2 of this plan is an operational/infra task that requires a live Cloudflare R2 API token supplied fresh by the user at execution time — it must be run by the controller directly (never dispatched to a fresh implementer subagent), and the token must never be echoed, logged, written to a file, or embedded in any persisted prompt.**

**Goal:** Stop `uniscrm.content`'s R2 Data Catalog table from accumulating duplicate rows, and guarantee the daily dashboard auto-recompute always reads post-compaction data.

**Architecture:** Apply the exact fix pattern already used for `uniscrm.user` ([ADR 0002](../../adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md)): gate `content.ts`'s pipeline send on an `unchanged` check, recreate dev's content R2 pipeline from scratch (old one is append-only with no schema file), extend the existing generic PyIceberg compactor to `uniscrm.content`, and fix `scheduled()`'s ordering so compaction always completes before the dashboard-recompute enqueue.

**Tech Stack:** Cloudflare Workers (Hono), Cloudflare Pipelines / R2 Data Catalog, PyIceberg REST Catalog protocol, TypeScript, Vitest.

## Global Constraints

- 少改动、稳定优先 (repo CLAUDE.md): mirror the already-approved `x-users.ts` fix pattern exactly rather than inventing a new approach.
- dev's existing 367 duplicate `uniscrm.content` rows are disposable — no data migration (user-confirmed).
- Production has no `PIPELINE_CONTENT` infrastructure at all and stays untouched — explicitly out of scope, same as the still-deferred production `PIPELINE_USER` provisioning.
- Per root CLAUDE.md coding-agent workflow: run self-tests and review/add test cases before reporting each task done.
- Never persist the R2 API token (no file writes, no `ScheduleWakeup` prompt embedding, no echoing it back) — use it only in direct, one-off Bash calls within the turn it's needed.

---

## File Structure

- **Modify** `link/src/services/content.ts` — add the `unchanged` gate to `upsertContentFromMetadata`, add a `CONTENT_TABLE_COLUMNS` constant.
- **Modify** `link/tests/services/content.test.ts` — add tests for the new gate.
- **Modify** `link/wrangler.toml` — `PIPELINE_CONTENT` binding switches from the old `pipeline = "..."` id to a `stream = "..."` id (matching `PIPELINE_USER`'s already-recreated shape).
- **Create** `analytics/pipelines/content-stream-schema.json` — didn't exist before; documents the recreated stream's schema, matching `user-stream-schema.json`'s pattern.
- **Modify** `analytics/src/index.ts` — add `compactContentTable(env)`, call it (and reorder relative to `compactUserTable`) inside `scheduled()` before the dashboard-report enqueue loop.

---

### Task 1: Gate content.ts's pipeline send on an unchanged check

**Files:**
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature changes — `upsertContentFromMetadata`'s return type (`Promise<boolean>`) and parameters are unchanged; only its internal pipeline-send condition changes.

- [ ] **Step 1: Write the failing tests**

Add these two tests to the `describe("ContentService.upsertContentFromMetadata", ...)` block in `link/tests/services/content.test.ts` (insert after the existing `"sends only isInsight props to the content pipeline..."` test, before the `"omits an unresolved column-mapped field..."` test):

```ts
  it("does not send to the pipeline when the resolved values exactly match the existing row", async () => {
    tenantDb.query.mockResolvedValue([{
      id: "existing-uuid",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    }]);
    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipelineContent as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    };

    await svc.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(pipelineContent.send).not.toHaveBeenCalled();
  });

  it("still sends to the pipeline when a resolved value differs from the existing row", async () => {
    tenantDb.query.mockResolvedValue([{
      id: "existing-uuid",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    }]);
    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipelineContent as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 2, // changed from 1
    };

    await svc.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: the new "does not send to the pipeline when the resolved values exactly match" test FAILS (pipeline.send is currently called unconditionally, so `not.toHaveBeenCalled()` fails). The "still sends... differs" test passes already (no behavior change needed for that case) — that's fine, it's there as a regression guard for the next step.

- [ ] **Step 3: Implement the unchanged gate**

In `link/src/services/content.ts`, change:

```ts
// propId -> content column. All propIds here are 1:1 name matches with their column.
// A resolved prop not in this map only ever lives in raw_data.
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  impression_count: "impression_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
};
```

to:

```ts
// propId -> content column. All propIds here are 1:1 name matches with their column.
// A resolved prop not in this map only ever lives in raw_data.
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  impression_count: "impression_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
};
const CONTENT_TABLE_COLUMNS = Object.values(CONTENT_COLUMN_MAP);
```

Then change `upsertContentFromMetadata`'s existing-row query and the code right after it — from:

```ts
    const existing = await this.tenantDb.query<{ id: string }>(
      "SELECT id FROM content WHERE channel_id = ? AND source_content_id = ?",
      [channelId, sourceContentId]
    );
    const isNew = existing.length === 0;
    const id = isNew ? crypto.randomUUID() : existing[0].id;
    const now = new Date().toISOString();
    const rawData = JSON.stringify(rawItem);

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }
    const dynamicCols = Object.keys(columnValues);
```

to:

```ts
    const existing = await this.tenantDb.query<Record<string, unknown> & { id: string }>(
      `SELECT id, ${CONTENT_TABLE_COLUMNS.join(", ")} FROM content WHERE channel_id = ? AND source_content_id = ?`,
      [channelId, sourceContentId]
    );
    const isNew = existing.length === 0;
    const id = isNew ? crypto.randomUUID() : existing[0].id;
    const now = new Date().toISOString();
    const rawData = JSON.stringify(rawItem);

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }
    const dynamicCols = Object.keys(columnValues);
    // Incremental poller re-walks recently-seen posts every cron tick (see
    // pollers/x-posts.ts's runIncrementalPoll) — without this check, every visit resends
    // an unchanged content row to the R2 pipeline, which has no dedup on write (append-only
    // Iceberg sink; see docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md).
    const unchanged = !isNew && dynamicCols.every((c) => String(columnValues[c]) === String(existing[0][c] ?? ""));
```

Then change the pipeline-send gate — from:

```ts
    if (this.pipelineContent && this.tenantId) {
```

to:

```ts
    if (this.pipelineContent && this.tenantId && !unchanged) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: all tests in this file PASS, including the two new ones.

- [ ] **Step 5: Typecheck**

Run: `cd link && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "Gate content pipeline send on an unchanged check"
```

---

### Task 1.5 (discovered mid-execution, not in the original plan): Upgrade vitest-pool-workers to unblock link's test suite

While verifying Task 1's tests, the controller discovered `link`'s entire vitest suite could not run at all — the bundled wrangler inside the pinned `@cloudflare/vitest-pool-workers@^0.8.0` doesn't recognize the `stream` field on pipelines bindings (introduced for `PIPELINE_USER` in commit `3c14c20`, unrelated to and predating this plan). No 0.8.x-0.12.x version fixes this; only 0.13+ does, which requires vitest 4.

**Files:**
- Modify: `link/package.json`, `link/vitest.config.ts`, `link/tests/services/x-users.test.ts` (a genuinely broken pre-existing mock, uncovered only once the suite could run again)
- Modify: `web/package.json`, `web/vitest.config.ts` (upgraded alongside for version consistency, per user decision — not itself blocking anything, since `web`'s wrangler.toml has no `stream` fields)
- Modify: `admin/package.json` (version bump only — admin has no `vitest.config.ts` and doesn't actually use the plugin)

This was executed directly by the controller (exploratory dependency-version archaeology, not "plan text contains the complete code to write"), verified via before/after A-B comparison (`git stash`/`git stash pop` around a clean `npm ci`) confirming zero regressions in all three modules, and committed as `8d6a48c`. See that commit's message for full detail. A task reviewer should still review this commit like any other task.

### Task 2: Recreate dev's content R2 pipeline (operational — controller runs directly)

**Files:**
- Create: `analytics/pipelines/content-stream-schema.json`
- Modify: `link/wrangler.toml`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a new `stream`-based `PIPELINE_CONTENT` binding in `link/wrangler.toml`'s `[env.dev.pipelines]` section — Task 3 doesn't depend on this (the compactor talks to R2 via the Iceberg REST Catalog directly, not through the pipeline binding), but this task must land before Task 4's manual dev verification, since a dashboard/report reading `uniscrm.content` needs the table to actually exist and accept new writes.

**Before starting:** ask the user (in chat, this turn) for a fresh Cloudflare R2 API token with Admin Read & Write scope. Use it only in the Bash commands below, in this same turn — do not write it to any file, do not echo it back in any message, do not put it in a `ScheduleWakeup` prompt.

- [ ] **Step 1: Discover the Iceberg REST Catalog's routing prefix**

dev's catalog URI and warehouse (already known, no token needed for this part):
- Catalog URI: `https://catalog.cloudflarestorage.com/b34f3ff4aec4c36584672d5bf1320757/uniscrm-dev`
- Warehouse: `b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev`

Run (substituting the token you were given):

```bash
curl -s "https://catalog.cloudflarestorage.com/b34f3ff4aec4c36584672d5bf1320757/uniscrm-dev/v1/config?warehouse=b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev" \
  -H "Authorization: Bearer $R2_TOKEN" | python3 -m json.tool
```

Expected: a JSON response containing an `overrides.prefix` field (this session's prior work found it to be a UUID-like string, e.g. `08ca766c-714a-11f1-8000-77e532ac8d4b` for the user-table recreation — dev's prefix should be identical since it's the same catalog, but confirm from this call's actual output rather than assuming).

- [ ] **Step 2: Drop the stale `uniscrm.content` Iceberg table**

Using the `prefix` from Step 1:

```bash
curl -s -X DELETE "https://catalog.cloudflarestorage.com/b34f3ff4aec4c36584672d5bf1320757/uniscrm-dev/v1/<PREFIX>/namespaces/uniscrm/tables/content?purge=true" \
  -H "Authorization: Bearer $R2_TOKEN"
```

Expected: success (204 or similar) or a "table not found" style response if it was already gone — either is fine, the goal is that the table doesn't exist afterward.

- [ ] **Step 3: Delete the old pipeline, sink, and stream**

```bash
cd link
wrangler pipelines delete uniscrm_content_pipeline_dev
wrangler pipelines sinks delete content_sink_dev
wrangler pipelines streams delete uniscrm_content_dev
```

Expected: each command confirms deletion. If a name doesn't match exactly, run `wrangler pipelines list`, `wrangler pipelines sinks list`, `wrangler pipelines streams list` first to get the exact current names (this plan's earlier discovery found them named `uniscrm_content_pipeline_dev` / `content_sink_dev` / `uniscrm_content_dev` — confirm before deleting).

- [ ] **Step 4: Write the stream schema file**

Create `analytics/pipelines/content-stream-schema.json`:

```json
{
  "fields": [
    { "name": "tenant_id", "type": "int32", "required": true },
    { "name": "id", "type": "string", "required": true },
    { "name": "channel_id", "type": "string", "required": true },
    { "name": "source_content_id", "type": "string", "required": true },
    { "name": "channel_type", "type": "string", "required": false },
    { "name": "created_at", "type": "string", "required": true },
    { "name": "updated_at", "type": "string", "required": true },
    { "name": "content_type", "type": "string", "required": false },
    { "name": "source_created_at", "type": "string", "required": false },
    { "name": "bookmark_count", "type": "int32", "required": false },
    { "name": "impression_count", "type": "int32", "required": false },
    { "name": "like_count", "type": "int32", "required": false },
    { "name": "quote_count", "type": "int32", "required": false },
    { "name": "reply_count", "type": "int32", "required": false },
    { "name": "repost_count", "type": "int32", "required": false }
  ]
}
```

- [ ] **Step 5: Create the new stream, sink, and pipeline**

```bash
cd link
wrangler pipelines streams create uniscrm_content_dev --schema-file ../analytics/pipelines/content-stream-schema.json

wrangler pipelines sinks create content_sink_dev \
  --type r2-data-catalog \
  --bucket uniscrm-dev \
  --namespace uniscrm \
  --table content \
  --catalog-token "$R2_TOKEN"

wrangler pipelines create uniscrm_content_pipeline_dev --sql "INSERT INTO content_sink_dev SELECT * FROM uniscrm_content_dev"
```

Expected: each command prints a new resource with a fresh ID. Record the new stream's ID from Step 5's first command output — you'll need it for Step 6.

- [ ] **Step 6: Update link/wrangler.toml's PIPELINE_CONTENT binding**

Change (in `[env.dev.pipelines]`):

```toml
[[env.dev.pipelines]]
binding = "PIPELINE_CONTENT"
pipeline = "137cceb43d1b4ce7be1b57c1f0c46660"
```

to (using the actual new stream ID from Step 5):

```toml
[[env.dev.pipelines]]
binding = "PIPELINE_CONTENT"
stream = "<NEW_STREAM_ID_FROM_STEP_5>"
```

- [ ] **Step 7: Verify the new table is reachable and empty**

```bash
cd analytics
wrangler r2 sql query uniscrm-dev "SELECT COUNT(*) FROM uniscrm.content"
```

Expected: `0` (fresh empty table, old duplicate rows gone).

- [ ] **Step 8: Commit**

```bash
git add analytics/pipelines/content-stream-schema.json link/wrangler.toml
git commit -m "Recreate dev content R2 pipeline from scratch (drop 367 dirty rows)"
```

---

### Task 3: Extend the compactor to uniscrm.content, fix scheduled()'s ordering

**Files:**
- Modify: `analytics/src/index.ts`

**Interfaces:**
- Consumes: the already-existing generic `/compact` endpoint on `CompactorContainer` (unchanged — accepts `table` and `key_columns` in its request body, per `analytics/compactor/main.py`).
- Produces: `compactContentTable(env: Env): Promise<void>` — a sibling to the existing `compactUserTable`, not consumed by any other task in this plan.

- [ ] **Step 1: Add compactContentTable and reorder scheduled()**

In `analytics/src/index.ts`, the current `scheduled()` handler and `compactUserTable` function read:

```ts
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const { results } = await env.ANALYTICS_DB.prepare(
      `SELECT DISTINCT ar.id, ar.tenant_id, ar.type, ar.params_json
       FROM analytics_reports ar
       JOIN dashboard_items di ON di.report_id = ar.id
       WHERE ar.status NOT IN ('pending', 'computing')`
    ).all<{ id: string; tenant_id: number; type: string; params_json: string }>();

    for (const row of results) {
      const params = row.params_json ? JSON.parse(row.params_json) : {};
      await env.ANALYTICS_DB.prepare(
        "UPDATE analytics_reports SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      ).bind(row.id).run();
      await env.ANALYTICS_QUEUE.send({
        report_id: row.id,
        type: row.type,
        params,
        tenant_id: String(row.tenant_id),
        warehouse: env.R2_WAREHOUSE,
      });
    }

    await compactUserTable(env);
  },
};

// R2 Data Catalog's Pipeline sink is append-only (no upsert/merge on write) and R2 SQL
// is read-only, so `uniscrm.user` accumulates one row per poll/webhook write instead of
// one row per user. This periodically rewrites the table down to the latest row per
// (tenant_id, channel_id, source_user_id) via the Iceberg REST catalog (PyIceberg), which
// is the only interface in this stack that can actually write/overwrite Iceberg tables.
async function compactUserTable(env: Env): Promise<void> {
```

Change to:

```ts
  // Compaction runs first and is awaited to completion before any dashboard report is
  // enqueued for recompute — otherwise the queue consumer (which runs independently of
  // this function) could read a still-duplicated R2 table if it processed a message
  // before compaction finished. See docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await compactUserTable(env);
    await compactContentTable(env);

    const { results } = await env.ANALYTICS_DB.prepare(
      `SELECT DISTINCT ar.id, ar.tenant_id, ar.type, ar.params_json
       FROM analytics_reports ar
       JOIN dashboard_items di ON di.report_id = ar.id
       WHERE ar.status NOT IN ('pending', 'computing')`
    ).all<{ id: string; tenant_id: number; type: string; params_json: string }>();

    for (const row of results) {
      const params = row.params_json ? JSON.parse(row.params_json) : {};
      await env.ANALYTICS_DB.prepare(
        "UPDATE analytics_reports SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      ).bind(row.id).run();
      await env.ANALYTICS_QUEUE.send({
        report_id: row.id,
        type: row.type,
        params,
        tenant_id: String(row.tenant_id),
        warehouse: env.R2_WAREHOUSE,
      });
    }
  },
};

// R2 Data Catalog's Pipeline sink is append-only (no upsert/merge on write) and R2 SQL
// is read-only, so `uniscrm.user` accumulates one row per poll/webhook write instead of
// one row per user. This periodically rewrites the table down to the latest row per
// (tenant_id, channel_id, source_user_id) via the Iceberg REST catalog (PyIceberg), which
// is the only interface in this stack that can actually write/overwrite Iceberg tables.
async function compactUserTable(env: Env): Promise<void> {
```

Then, immediately after `compactUserTable`'s closing brace (find it by locating the end of that function — it ends with the closing `}` that follows its `catch` block), add:

```ts

// Same rationale as compactUserTable, applied to uniscrm.content (see
// docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md).
async function compactContentTable(env: Env): Promise<void> {
  try {
    const instance = env.COMPACTOR_CONTAINER.getByName("singleton");
    await instance.startAndWaitForPorts();
    const res = await instance.fetch("http://container/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalog_uri: env.R2_CATALOG_URI,
        warehouse: env.R2_WAREHOUSE,
        namespace: "uniscrm",
        table: "content",
        key_columns: ["tenant_id", "channel_id", "source_content_id"],
        token: env.R2_CATALOG_TOKEN,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(JSON.stringify({ event: "content_compaction_error", status: res.status, body }));
    } else {
      console.log(JSON.stringify({ event: "content_compaction_done", body }));
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "content_compaction_error", error: err instanceof Error ? err.message : String(err) }));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no new errors (this module has ~150 pre-existing unrelated errors from missing root `@types/react` — confirm your change introduces none referencing `index.ts`'s `compactContentTable`/`scheduled`).

- [ ] **Step 3: Commit**

```bash
git add analytics/src/index.ts
git commit -m "Extend compactor to uniscrm.content; run compaction before dashboard recompute enqueue"
```

---

### Task 4: Manual verification in dev

**Files:** none (verification only)

- [ ] **Step 1: Run the full link test suite**

Run: `cd link && npx vitest run`
Expected: all tests pass, including Task 1's new ones.

- [ ] **Step 2: Deploy and confirm the content pipeline accepts writes**

After this plan's commits are pushed and `analytics`/`link` redeploy to dev (per this repo's CI convention — pushing to `main` auto-deploys dev), trigger a posts-poller cycle for a channel with X BYOK content configured (or wait for the next scheduled poll), then run:

```bash
cd analytics
wrangler r2 sql query uniscrm-dev "SELECT COUNT(*) FROM uniscrm.content"
```

Expected: a small, sane count (not zero, not runaway) reflecting only real content — no immediate massive duplication on the first poll cycle.

- [ ] **Step 3: Confirm compaction runs in the correct order**

Cloudflare cron triggers can be invoked manually for testing via the dashboard or `wrangler deployments` tooling, or wait for the next `0 2 * * *` UTC run. Check the `analytics` Worker's logs (Cloudflare dashboard → Workers → analytics → Logs, or `wrangler tail --env dev` run during a manual cron trigger) for the log line ordering: `user_compaction_done` and `content_compaction_done` must both appear before the first `report_id`-bearing enqueue-related log line in the same invocation.

- [ ] **Step 4: Report completion**

If any issue is found during manual verification, fix it in the relevant task's files, re-run that task's tests/typecheck, and commit the fix before reporting the plan complete.

---

## Self-Review Notes

- **Spec coverage:** §1 source-side fix → Task 1. §2 recreate dev pipeline → Task 2. §3 schema file → Task 2 Step 4. §4 extend compactor → Task 3. §5 scheduled() ordering → Task 3 (folded in, same function edit). §6 production out of scope → confirmed no task touches `env.production` anywhere in this plan.
- **Type consistency:** `compactContentTable(env: Env): Promise<void>` matches `compactUserTable`'s existing signature exactly. `CONTENT_TABLE_COLUMNS` is referenced consistently as a `string[]` derived via `Object.values(CONTENT_COLUMN_MAP)`.
- **No placeholders:** every step shows exact before/after code or exact commands; the only intentional placeholder is `$R2_TOKEN`/`<NEW_STREAM_ID_FROM_STEP_5>`/`<PREFIX>` in Task 2, which is operational (a live secret and IDs only known at execution time, not knowable in advance) — explicitly called out as controller-executed, not a spec gap.
