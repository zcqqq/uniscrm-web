# Content Flow Analytics — Node Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user clicks a node in a content flow's analytics page, show a per-content-item row: left side is a content preview (title, or first-5-chars-of-content_text + "…", plus a link — or the produced video's R2 link for a `videoAction` node); right side is the timestamp, with red "Failed" text when that content's execution at that node failed.

**Architecture:** Add `outcome`/`title`/`content_text`/`content_url` columns to the `content_flow_log` R2/Iceberg pipeline (and `outcome` only to `flow_log`, for symmetry) via a stream+pipeline rebuild (no in-place `ALTER` exists for Cloudflare Pipelines/R2 SQL). `engine.ts`'s `resumeFromNode` relabels its one duplicate-exit log entry to `direction: "outcome"` — but only for node types whose exit was already logged eagerly at dispatch (action-family nodes, `webhook`/`abSplit`/`userPropsCondition`/`videoCondition`); `wait`/`waitForEvent`/`timeCondition` keep their single legitimate `exit`, since those defer logging exit until resolution. `index.ts`'s `emitContentNodeLogs` gains a required `payload` parameter and stamps title/content_text/content_url onto every record in a batch (not just the outcome one), so trigger nodes — which never produce an outcome — still show a preview. The `/nodes/:nodeId/logs` endpoint drops its D1 `content` table join entirely (everything now lives in the R2 row) and de-duplicates by `content_id`. Pollers gain a `content_url` field in the payload (computed once, poller-side, for X/YouTube; taken from TikTok's own `share_url` API field).

**Tech Stack:** Cloudflare Workers (Hono), Cloudflare Pipelines / R2 Data Catalog (Apache Iceberg via R2 SQL), Vitest (`cloudflare:test` pool), React + TypeScript (flow frontend), wrangler CLI.

## Global Constraints

- Data accuracy > stability > features > UI (per repo `CLAUDE.md`) — the badge (enter/exit) counts must not change behavior; only new, additive signal is introduced.
- No inline CSS in frontend changes — use existing shared components/Tailwind utility classes already used in `AnalyticsPage.tsx`.
- `content` D1 table and `CONTENT_COLUMN_MAP` must NOT be touched — `content_url` flows only through `payload`/R2, never persisted to D1 (explicit scope decision).
- The destructive stream/pipeline rebuild (delete + recreate) in Task 1 is an explicit, user-approved exception to this repo's usual "don't delete/recreate prod resources" rule, justified by there being no real customer data yet. Do not treat this as precedent for other work.
- Every new/modified test must pass via `npm test` (flow) / `npm test` (link) before a task is considered done.

---

## Task 1: R2 pipeline schema — add `outcome`/`title`/`content_text`/`content_url` columns

**Files:**
- Modify: `analytics/pipelines/flow-log-stream-schema.json`
- Modify: `analytics/pipelines/content-flow-log-stream-schema.json`

**Interfaces:**
- Produces: the R2 Iceberg tables `uniscrm.flow_log` (adds `outcome`) and `uniscrm.content_flow_log` (adds `outcome`, `title`, `content_text`, `content_url`) that Task 3's `emitNodeLogs`/`emitContentNodeLogs` write to and Task 4's `queryNodeLogRows` reads from.

This is an infrastructure task — no application code changes, no Vitest tests. Verification is via live `wrangler`/R2 SQL commands.

- [ ] **Step 1: Update the two schema files**

`analytics/pipelines/flow-log-stream-schema.json` (add one field):

```json
{
  "fields": [
    { "name": "tenant_id", "type": "int32", "required": true },
    { "name": "id", "type": "string", "required": true },
    { "name": "flow_id", "type": "string", "required": true },
    { "name": "node_id", "type": "string", "required": true },
    { "name": "user_id", "type": "string", "required": true },
    { "name": "direction", "type": "string", "required": true },
    { "name": "outcome", "type": "string", "required": false },
    { "name": "created_at", "type": "string", "required": true }
  ]
}
```

`analytics/pipelines/content-flow-log-stream-schema.json` (add four fields):

```json
{
  "fields": [
    { "name": "tenant_id", "type": "int32", "required": true },
    { "name": "id", "type": "string", "required": true },
    { "name": "flow_id", "type": "string", "required": true },
    { "name": "node_id", "type": "string", "required": true },
    { "name": "content_id", "type": "string", "required": true },
    { "name": "direction", "type": "string", "required": true },
    { "name": "outcome", "type": "string", "required": false },
    { "name": "title", "type": "string", "required": false },
    { "name": "content_text", "type": "string", "required": false },
    { "name": "content_url", "type": "string", "required": false },
    { "name": "created_at", "type": "string", "required": true }
  ]
}
```

- [ ] **Step 2: Rebuild the dev stream + pipeline for `flow_log`**

`wrangler pipelines streams` has no update command (create/list/get/delete only) and R2 SQL rejects `ALTER`/`CREATE`/`DROP` ("only read-only queries are allowed") — schema changes require deleting and recreating the stream + pipeline. The sink (`flow_log_sink_dev`, pointing at Iceberg table `uniscrm.flow_log` by `--table` name) is untouched here — sinks persist independently of stream/pipeline lifecycle, so existing rows are not affected.

```bash
wrangler pipelines streams delete uniscrm_flow_log_dev -y
wrangler pipelines streams create uniscrm_flow_log_dev --schema-file analytics/pipelines/flow-log-stream-schema.json
wrangler pipelines create uniscrm_flow_log_pipeline_dev --sql "INSERT INTO flow_log_sink_dev SELECT * FROM uniscrm_flow_log_dev"
```

Expected: each command prints a new resource ID. `wrangler pipelines streams get uniscrm_flow_log_dev` should show `outcome` in the Input Schema table.

- [ ] **Step 3: Rebuild the dev stream, sink, and pipeline for `content_flow_log` (also fixes the pre-existing failed sink credential)**

`content_flow_log_sink_dev`'s `--catalog-token` is currently invalid (`wrangler pipelines list` shows `uniscrm_content_flow_log_pipeline_dev` in `failed` status with `R2 bucket [uniscrm-dev]: invalid credentials (signature mismatch)`) — pre-existing, unrelated to this feature, but since the sink is being rebuilt anyway, use a fresh token. Get a current, valid R2 API token (Cloudflare dashboard → R2 → Manage API Tokens, or check the project's password manager entry used when this sink was first created) and export it as `R2_TOKEN` before running:

```bash
wrangler pipelines streams delete uniscrm_content_flow_log_dev -y
wrangler pipelines streams create uniscrm_content_flow_log_dev --schema-file analytics/pipelines/content-flow-log-stream-schema.json
wrangler pipelines sinks delete content_flow_log_sink_dev -y
wrangler pipelines sinks create content_flow_log_sink_dev \
  --type r2-data-catalog --bucket uniscrm-dev --namespace uniscrm --table content_flow_log \
  --catalog-token "$R2_TOKEN"
wrangler pipelines create uniscrm_content_flow_log_pipeline_dev --sql "INSERT INTO content_flow_log_sink_dev SELECT * FROM uniscrm_content_flow_log_dev"
```

Expected: each command prints a new resource ID. `wrangler pipelines list` should show `uniscrm_content_flow_log_pipeline_dev` in `running` status (not `failed`).

- [ ] **Step 4: Verify dev via a real write, then read-only R2 SQL**

Trigger any published content flow in dev (or wait for the next natural poll cycle), then:

```bash
wrangler r2 sql query <warehouse> "DESCRIBE uniscrm.content_flow_log"
wrangler r2 sql query <warehouse> "SELECT node_id, direction, outcome, title, content_text, content_url, created_at FROM uniscrm.content_flow_log ORDER BY created_at DESC LIMIT 5"
```

(`<warehouse>` is the `R2_WAREHOUSE` value in `flow/wrangler.toml`, e.g. `<account-id>_uniscrm-dev` — not the bucket name.) Expected: `DESCRIBE` lists all 4 new columns; the `SELECT` shows recent rows (the new columns will be populated once Tasks 2–3 are deployed — until then they'll be NULL, which is fine, the stream/table change is independent of and precedes the application code change).

- [ ] **Step 5: Repeat Steps 2–3 for production (no `_dev` suffix, bucket `uniscrm`)**

Only proceed once dev verification in Step 4 succeeds.

```bash
wrangler pipelines streams delete uniscrm_flow_log -y
wrangler pipelines streams create uniscrm_flow_log --schema-file analytics/pipelines/flow-log-stream-schema.json
wrangler pipelines create uniscrm_flow_log_pipeline --sql "INSERT INTO flow_log_sink SELECT * FROM uniscrm_flow_log"

wrangler pipelines streams delete uniscrm_content_flow_log -y
wrangler pipelines streams create uniscrm_content_flow_log --schema-file analytics/pipelines/content-flow-log-stream-schema.json
wrangler pipelines create uniscrm_content_flow_log_pipeline --sql "INSERT INTO content_flow_log_sink SELECT * FROM uniscrm_content_flow_log"
```

Production's `content_flow_log_sink` credential is not known to be broken — do NOT delete/recreate that sink, only the stream and pipeline (which don't need the sink's token).

Expected: `wrangler pipelines list` shows both production pipelines in `running` status.

- [ ] **Step 6: Commit the schema files**

```bash
git add analytics/pipelines/flow-log-stream-schema.json analytics/pipelines/content-flow-log-stream-schema.json
git commit -m "feat(analytics): add outcome/title/content_text/content_url columns to flow_log/content_flow_log pipelines"
```

---

## Task 2: `engine.ts` — `NodeLog.outcome` + type-conditional relabeling in `resumeFromNode`

**Files:**
- Modify: `flow/src/engine.ts:34-38` (the `NodeLog` interface — exact lines may have shifted; search for `export interface NodeLog`)
- Modify: `flow/src/engine.ts:210` (inside `resumeFromNode` — search for `nodeLogs.push({ nodeId, direction: "exit" });` immediately following `const nodeLogs: NodeLog[] = [];` inside `export function resumeFromNode`)
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: `FlowGraph` (has `.nodes: FlowNode[]`, each with `.id` and `.type`), already imported in `engine.ts`.
- Produces: `NodeLog { nodeId: string; direction: "enter" | "exit" | "outcome"; outcome?: string }` — Task 3 reads `.direction` and `.outcome` when building R2 records.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/engine.test.ts` (append inside or near the existing `describe("resumeFromNode: action branch targets get full actionData", ...)` block — these two new tests, alongside the three pre-existing ones already in that block):

```typescript
describe("resumeFromNode: outcome relabeling is conditional on the resumed node's type", () => {
  it("relabels index-0 to 'outcome' with the branch when resuming an action node (exit was already logged eagerly at dispatch)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "a1", target: "a2", sourceHandle: "success" }],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.nodeLogs[0]).toEqual({ nodeId: "a1", direction: "outcome", outcome: "success" });
  });

  it("keeps index-0 as a plain 'exit' (no outcome) when resuming a wait/waitForEvent/timeCondition node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "w1", type: "wait", data: { duration: 5, unit: "minutes" }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "w1", target: "a1" }],
    };
    const result = resumeFromNode(graph, "w1", {}, undefined);
    expect(result.nodeLogs[0]).toEqual({ nodeId: "w1", direction: "exit" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts -t "outcome relabeling"
```

Expected: FAIL — current code always pushes `{ nodeId, direction: "exit" }` at index 0, so the first new test's `toEqual` (expecting `direction: "outcome"`) fails; the second passes already (no regression yet) but keep both since the fix touches shared code.

- [ ] **Step 3: Update the `NodeLog` interface**

Find (near the top of `flow/src/engine.ts`, search `export interface NodeLog`):

```typescript
export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit";
}
```

Replace with:

```typescript
export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit" | "outcome";
  outcome?: string;
}
```

- [ ] **Step 4: Update `resumeFromNode`'s index-0 push**

Find, inside `export function resumeFromNode(...)`, the first `nodeLogs.push` call (immediately after `const nodeLogs: NodeLog[] = [];`):

```typescript
  nodeLogs.push({ nodeId, direction: "exit" });
```

Replace with:

```typescript
  // wait/waitForEvent/timeCondition defer logging "exit" until resolution (collectActions never
  // logs it eagerly for these three types — see their branches below) — this IS their one
  // legitimate exit and must stay countable. Every other resumable type (all "action" nodes,
  // plus webhook/abSplit/userPropsCondition/videoCondition) already had "exit" logged eagerly at
  // dispatch time; this second push is a duplicate, so it's relabeled "outcome" (carrying the
  // resolved branch) instead of counted again.
  const originatingNode = graph.nodes.find((n) => n.id === nodeId);
  const DEFERRED_EXIT_TYPES = ["wait", "waitForEvent", "timeCondition"];
  if (originatingNode && DEFERRED_EXIT_TYPES.includes(originatingNode.type)) {
    nodeLogs.push({ nodeId, direction: "exit" });
  } else {
    nodeLogs.push({ nodeId, direction: "outcome", outcome: branch });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: PASS — all tests in the file, including the pre-existing `resumeFromNode` ones (they check `.actions`/`.pendingWaits`/filtered nodeLogs by a *different* nodeId than the one being resumed, so they're unaffected by index-0's relabeling).

- [ ] **Step 6: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): relabel resumeFromNode's duplicate exit as outcome, conditional on node type"
```

---

## Task 3: `index.ts` — `emitContentNodeLogs`/`emitNodeLogs` rewrite + all call sites

**Files:**
- Modify: `flow/src/index.ts` (function definitions near the top, plus 18 call sites — 15 to `emitContentNodeLogs`, 3 to `emitNodeLogs`)
- Test: `flow/tests/unit/content-action-branch-node-logs.test.ts`
- Test: `flow/tests/unit/video-action-resume.test.ts`
- Test: `flow/tests/unit/scheduled-content.test.ts`

**Interfaces:**
- Consumes: Task 2's `NodeLog { nodeId, direction, outcome? }`.
- Produces: `emitContentNodeLogs(nodeLogs, flowId, contentId, tenantId, env, payload)` (payload now required) and `emitNodeLogs` (signature unchanged) — both used by Task 4's read path indirectly via the R2 rows they write.

Before editing, re-run this search to get current line numbers (they shift as other work lands on this file):

```bash
cd flow/src && grep -n "resumeFromNode(\|emitContentNodeLogs(\|emitNodeLogs(" index.ts
```

- [ ] **Step 1: Write/update the failing tests**

In `flow/tests/unit/content-action-branch-node-logs.test.ts`, update all three `it(...)` bodies' final assertions (the file's own header comment explaining the "duplicate exit" behavior also needs a one-line update, since it's now relabeled instead of dropped):

Replace this comment block (lines 13-17):

```typescript
// resumeFromNode's returned nodeLogs always has a duplicate exit for "a1" at index 0 (a1's
// enter+exit were already logged when it was first collected as an action) — everything from
// index 1 onward (a2 or a3's genuine enter+exit) is new and must be emitted via
// emitContentNodeLogs/PIPELINE_CONTENT_FLOW_LOG.send. Prior to the fix, both call sites silently
// dropped resumed/failedResult.nodeLogs entirely.
```

with:

```typescript
// resumeFromNode's returned nodeLogs[0] is a1's own duplicate exit, relabeled direction:"outcome"
// (carrying the resolved branch) rather than dropped — everything from index 1 onward (a2 or a3's
// genuine enter+exit) is the new downstream traversal. Both are emitted via
// emitContentNodeLogs/PIPELINE_CONTENT_FLOW_LOG.send.
```

Replace (test 1, "emits a2's enter+exit..."):

```typescript
    const [secondCallRecords] = pipelineSend.mock.calls[1];
    // Exactly a2's enter+exit — NOT a1's duplicate exit (resumeFromNode's raw nodeLogs[0]).
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a2:enter", "a2:exit",
    ]);
    expect(secondCallRecords.every((r: any) => r.content_id === "content-nodelog-1")).toBe(true);
```

with:

```typescript
    const [secondCallRecords] = pipelineSend.mock.calls[1];
    // a1's relabeled outcome row, then a2's genuine enter+exit.
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a2:enter", "a2:exit",
    ]);
    expect(secondCallRecords[0].outcome).toBe("success");
    expect(secondCallRecords.every((r: any) => r.content_id === "content-nodelog-1")).toBe(true);
```

Replace (test 2, "emits a3's enter+exit when the failed branch resolves synchronously"):

```typescript
    expect(pipelineSend).toHaveBeenCalledTimes(2);
    const [secondCallRecords] = pipelineSend.mock.calls[1];
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a3:enter", "a3:exit",
    ]);
  });
});
```

with:

```typescript
    expect(pipelineSend).toHaveBeenCalledTimes(2);
    const [secondCallRecords] = pipelineSend.mock.calls[1];
    expect(secondCallRecords.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(secondCallRecords[0].outcome).toBe("failed");
  });
});
```

Replace (test 3, "emits a3's enter+exit when rate-limit retries are exhausted..."):

```typescript
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    // Exactly a3's enter+exit — NOT a1's duplicate exit (failedResult.nodeLogs[0]).
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a3:enter", "a3:exit",
    ]);
    expect(records.every((r: any) => r.content_id === "content-nodelog-3")).toBe(true);
```

with:

```typescript
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual([
      "a1:outcome", "a3:enter", "a3:exit",
    ]);
    expect(records[0].outcome).toBe("failed");
    expect(records.every((r: any) => r.content_id === "content-nodelog-3")).toBe(true);
```

In `flow/tests/unit/video-action-resume.test.ts`, find the assertion `expect(records.map((r: any) => \`${r.node_id}:${r.direction}\`)).toEqual(["a2:enter", "a2:exit"]);` (around line 128) and replace with:

```typescript
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a2:enter", "a2:exit"]);
```

In `flow/tests/unit/scheduled-content.test.ts`, find the assertion and its preceding comment block (around lines 155-168, the "a timed-out videoAction pending row..." test) — replace the comment:

```typescript
    // Note: this generic sweep path emits result.nodeLogs unsliced (unlike the dedicated
    // resume route and the xContentAction retry-exhausted path, which both slice off index 0
    // to avoid a duplicate exit log) — nodeLogs[0] here is a duplicate exit for a1 (whose
    // enter+exit were already logged at initial dispatch, before the async videoAction queue
    // hand-off). That's a pre-existing minor log-duplication quirk of the general timeout path,
    // out of this task's scope (which is limited to the branch-resolution fix); only the
    // "failed"-branch resolution below (a3, not a hang) is what this test asserts on.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:exit", "a3:enter", "a3:exit"]);
```

with:

```typescript
    // This generic sweep path emits result.nodeLogs in full (no slicing) — a1's index-0 entry
    // is now correctly relabeled direction:"outcome" (Task 2's engine.ts fix) instead of the
    // previous "a1:exit" duplicate, so the exit badge for a1 is no longer double-counted here.
    expect(pipelineSend).toHaveBeenCalledTimes(1);
    const [records] = pipelineSend.mock.calls[0];
    expect(records.map((r: any) => `${r.node_id}:${r.direction}`)).toEqual(["a1:outcome", "a3:enter", "a3:exit"]);
    expect(records[0].outcome).toBe("failed");
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd flow && npx vitest run tests/unit/content-action-branch-node-logs.test.ts tests/unit/video-action-resume.test.ts tests/unit/scheduled-content.test.ts
```

Expected: FAIL — `emitContentNodeLogs` still requires a `payload` argument change and the call sites still `.slice(1)`, so `a1:outcome`/`a1:exit` never appears in any of these result arrays yet.

- [ ] **Step 3: Rewrite `emitNodeLogs` and `emitContentNodeLogs`**

Find (top of `flow/src/index.ts`):

```typescript
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

Replace with:

```typescript
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
    outcome: log.direction === "outcome" ? log.outcome : undefined,
    created_at: timestamp,
  }));
  await env.PIPELINE_FLOW_LOG?.send(records).catch(() => {});
}

async function emitContentNodeLogs(
  nodeLogs: NodeLog[],
  flowId: string,
  contentId: string,
  tenantId: string,
  env: Env,
  payload: Record<string, unknown>
): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  // processed_video_url (set once a videoAction node produces a new video) takes priority over
  // the originating trigger's content_url — any node downstream of a resolved videoAction is
  // now "about" that produced video, including a second chained videoAction (see engine.ts's
  // videoAction handling in executeContentActions).
  const contentUrl = (payload?.processed_video_url as string) || (payload?.content_url as string) || undefined;
  const records = nodeLogs.map((log) => ({
    tenant_id: Number(tenantId),
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    content_id: contentId,
    direction: log.direction,
    outcome: log.direction === "outcome" ? log.outcome : undefined,
    title: payload?.title as string | undefined,
    content_text: payload?.content_text as string | undefined,
    content_url: contentUrl,
    created_at: timestamp,
  }));
  await env.PIPELINE_CONTENT_FLOW_LOG?.send(records).catch(() => {});
}
```

- [ ] **Step 4: Update all `emitContentNodeLogs` call sites**

Re-run `grep -n "emitContentNodeLogs(" flow/src/index.ts` to get current line numbers before editing (this file changes frequently). There are 15 call sites in two shapes:

**Shape A — 13 sites currently reading** `if (X.nodeLogs.length > 1) await emitContentNodeLogs(X.nodeLogs.slice(1), ARGS);` **where `X` is `resumed`, `resolved`, or `failedResult`.** For each, remove the `.slice(1)`, change `> 1` to `> 0`, and add `payload` as the final argument. Concretely, replace every occurrence of the literal substring (10 of the 13 share this exact `resumed`/`flowId || "", contentId, tenantId, env` shape — use `replace_all: true` for this one):

```typescript
resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
```

with:

```typescript
resumed.nodeLogs.length > 0) await emitContentNodeLogs(resumed.nodeLogs, flowId || "", contentId, tenantId, env, payload);
```

The remaining 3 of the 13 have distinct argument shapes — handle individually:

```typescript
if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), row.flow_id, row.content_id, String(row.tenant_id), c.env);
```
→
```typescript
if (resumed.nodeLogs.length > 0) await emitContentNodeLogs(resumed.nodeLogs, row.flow_id, row.content_id, String(row.tenant_id), c.env, payload);
```

```typescript
if (resolved.nodeLogs.length > 1) await emitContentNodeLogs(resolved.nodeLogs.slice(1), row.flow_id, row.content_id, row.tenant_id, env);
```
→
```typescript
if (resolved.nodeLogs.length > 0) await emitContentNodeLogs(resolved.nodeLogs, row.flow_id, row.content_id, row.tenant_id, env, payload);
```

```typescript
if (failedResult.nodeLogs.length > 1) await emitContentNodeLogs(failedResult.nodeLogs.slice(1), row.flow_id, row.content_id, row.tenant_id, env);
```
→
```typescript
if (failedResult.nodeLogs.length > 0) await emitContentNodeLogs(failedResult.nodeLogs, row.flow_id, row.content_id, row.tenant_id, env, payload);
```

**Shape B — 2 sites already passing the full array** (no `.slice`), just need `payload` appended:

```typescript
if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, flow.id, contentId, tenantId, env);
```
(inside `queue()`, where the in-scope payload variable is `matchPayload`, not `payload`) →
```typescript
if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, flow.id, contentId, tenantId, env, matchPayload);
```

```typescript
if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, row.flow_id, row.content_id, row.tenant_id, env);
```
(inside the generic `content_flow_pending` sweep in `scheduled()`) →
```typescript
if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, row.flow_id, row.content_id, row.tenant_id, env, payload);
```

After editing, run `grep -n "emitContentNodeLogs(" flow/src/index.ts` again and confirm there are exactly 15 call sites, none containing `.slice(1)`, and every one ends with `, payload)` or `, matchPayload)`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd flow && npx vitest run tests/unit/content-action-branch-node-logs.test.ts tests/unit/video-action-resume.test.ts tests/unit/scheduled-content.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full flow test suite to catch any other break**

```bash
cd flow && npm test
```

Expected: all tests pass (TypeScript will also fail to compile if any of the 15 call sites was missed, since `payload` became a required parameter — that's a deliberate safety net, not a bug to work around).

- [ ] **Step 7: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/content-action-branch-node-logs.test.ts flow/tests/unit/video-action-resume.test.ts flow/tests/unit/scheduled-content.test.ts
git commit -m "feat(flow): stamp outcome/title/content_text/content_url onto every content_flow_log record"
```

---

## Task 4: `/api/flows/:id/nodes/:nodeId/logs` — drop D1 join, dedupe by content_id

**Files:**
- Modify: `flow/src/index.ts` (`queryNodeLogRows` function and the `app.get("/api/flows/:id/nodes/:nodeId/logs", ...)` handler — search for these exact strings, current line numbers ~68 and ~1286 but may have shifted from Task 3's edits)
- Test: `flow/tests/unit/node-logs-endpoint.test.ts`

**Interfaces:**
- Consumes: Task 3's R2 rows (now carrying `outcome`/`title`/`content_text`/`content_url`).
- Produces: `GET /api/flows/:id/nodes/:nodeId/logs` response shape `{ logs: { content_id?: string; user_id?: string; created_at: string; outcome?: string; title?: string; content_text?: string; content_url?: string }[] }` — consumed by Task 6's frontend `api.ts`/`AnalyticsPage.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/node-logs-endpoint.test.ts`, inside the `describe("queryNodeLogRows", ...)` block, replacing the existing `"queries uniscrm.content_flow_log with content_id as the subject column"` test:

```typescript
  it("queries uniscrm.content_flow_log for both enter and outcome rows, returning the new detail columns", async () => {
    fetchMock.mockResolvedValue(mockR2Response([
      { content_id: "c1", created_at: "2026-01-01T00:00:01.000Z", direction: "outcome", outcome: "failed", title: null, content_text: "hello world", content_url: "https://x.com/i/status/1" },
    ]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.content_flow_log", "content_id", 42, "flow-2", "node-2");

    expect(rows).toEqual([{
      subjectId: "c1", created_at: "2026-01-01T00:00:01.000Z", direction: "outcome",
      outcome: "failed", title: null, content_text: "hello world", content_url: "https://x.com/i/status/1",
    }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.content_flow_log");
    expect(body.query).toContain("direction IN ('enter', 'outcome')");
  });
```

Add a new `describe` block (append at the end of the file, before the final closing) for the dedup + no-D1-join behavior:

```typescript
describe("GET /api/flows/:id/nodes/:nodeId/logs — content domain reads R2 only, no D1 join", () => {
  const TENANT_ID = 999;
  const FLOW_ID = "33333333-3333-3333-3333-333333333333";
  const NODE_ID = "44444444-4444-4444-4444-444444444444";
  let fetchMock: ReturnType<typeof vi.fn>;

  function req(path: string) {
    return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
  }

  beforeEach(async () => {
    fetchMock = vi.fn(async (url: string, init?: any) => {
      if (String(url).includes("/api/auth/me")) {
        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
      }
      // Two rows for the same content_id: an earlier "enter" and a later "outcome" — the route
      // must dedupe to the latest (the outcome row), not return both.
      return mockR2Response([
        { content_id: "c-dup", created_at: "2026-01-02T00:00:00.000Z", direction: "outcome", outcome: "success", title: null, content_text: "second tweet text", content_url: "https://x.com/i/status/2" },
        { content_id: "c-dup", created_at: "2026-01-01T00:00:00.000Z", direction: "enter", outcome: null, title: null, content_text: "second tweet text", content_url: "https://x.com/i/status/2" },
      ]);
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
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, graph_json, status, created_at, updated_at) VALUES (?, ?, '{"nodes":[{"id":"t1","type":"xContentTrigger","data":{}}],"edges":[]}', 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, TENANT_ID).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("returns one deduped row per content_id with title/content_text/content_url/outcome, no D1 query", async () => {
    const res = await worker.fetch(req(`/api/flows/${FLOW_ID}/nodes/${NODE_ID}/logs`), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: any[] };
    expect(body.logs).toEqual([{
      content_id: "c-dup", created_at: "2026-01-02T00:00:00.000Z", outcome: "success",
      title: null, content_text: "second tweet text", content_url: "https://x.com/i/status/2",
    }]);
    // No D1 SELECT against the content table — every fetch call was either /api/auth/me or R2 SQL.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.every((u) => u.includes("/api/auth/me") || u.includes("r2-sql"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd flow && npx vitest run tests/unit/node-logs-endpoint.test.ts
```

Expected: FAIL — `queryNodeLogRows` still only selects `${subjectColumn}, created_at` and filters `direction = 'enter'`; the route still joins D1 and returns `{ content_id, name, created_at }`.

- [ ] **Step 3: Rewrite `queryNodeLogRows`**

Find:

```typescript
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

Replace with:

```typescript
export interface NodeLogRow {
  subjectId: string;
  created_at: string;
  direction: string;
  outcome: string | null;
  title: string | null;
  content_text: string | null;
  content_url: string | null;
}

export async function queryNodeLogRows(
  env: Env,
  table: "uniscrm.flow_log" | "uniscrm.content_flow_log",
  subjectColumn: "user_id" | "content_id",
  tenantId: number,
  flowId: string,
  nodeId: string
): Promise<NodeLogRow[]> {
  const res = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_BUCKET}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.R2_SQL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouse: env.R2_WAREHOUSE,
        query: `SELECT ${subjectColumn}, created_at, direction, outcome, title, content_text, content_url FROM ${table}
                WHERE tenant_id = ${tenantId} AND flow_id = '${flowId}' AND node_id = '${nodeId}' AND direction IN ('enter', 'outcome')
                ORDER BY created_at DESC LIMIT 50`,
      }),
    }
  );
  const data = await res.json() as { result?: { rows: Record<string, unknown>[] }; success: boolean };
  if (!data.success) return [];
  return (data.result?.rows || []).map((r) => ({
    subjectId: String(r[subjectColumn]),
    created_at: String(r.created_at),
    direction: String(r.direction),
    outcome: (r.outcome as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    content_text: (r.content_text as string | null) ?? null,
    content_url: (r.content_url as string | null) ?? null,
  }));
}
```

(User-flow callers of `queryNodeLogRows` only destructure `subjectId`/`created_at` from the result today — adding fields to the return type doesn't break them.)

- [ ] **Step 4: Rewrite the route handler's content-domain branch**

Find, inside `app.get("/api/flows/:id/nodes/:nodeId/logs", ...)`:

```typescript
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
```

Replace with:

```typescript
    const rows = await queryNodeLogRows(
      c.env,
      isContentDomain ? "uniscrm.content_flow_log" : "uniscrm.flow_log",
      isContentDomain ? "content_id" : "user_id",
      Number(tenantId),
      flowId,
      nodeId
    );
    if (rows.length === 0) return c.json({ logs: [] });

    if (isContentDomain) {
      // Rows arrive ordered by created_at DESC; a content_id can have both an "enter" row
      // (outcome unresolved yet) and a later "outcome" row (same title/content_text/content_url,
      // since both come from the same payload batch) — keep only the first (= latest) occurrence
      // per content_id, which is the outcome row whenever one exists. No D1 join: every display
      // field now lives directly on the R2 row.
      const seen = new Set<string>();
      const logs = [];
      for (const r of rows) {
        if (seen.has(r.subjectId)) continue;
        seen.add(r.subjectId);
        logs.push({
          content_id: r.subjectId,
          created_at: r.created_at,
          outcome: r.outcome ?? undefined,
          title: r.title,
          content_text: r.content_text,
          content_url: r.content_url,
        });
      }
      return c.json({ logs });
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId).first<{ d1_database_id: string | null }>();
    if (!tenantRow?.d1_database_id) {
      return c.json({ logs: rows.map((r) => ({ user_id: r.subjectId, name: null, created_at: r.created_at })) });
    }

    const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const ids = [...new Set(rows.map((r) => r.subjectId))];
    const placeholders = ids.map(() => "?").join(",");
    const nameRows = await tdb.query<{ id: string; name: string | null }>(`SELECT id, name FROM user WHERE id IN (${placeholders})`, ids);
    const nameMap = new Map(nameRows.map((r) => [r.id, r.name]));

    const logs = rows.map((r) => ({
      user_id: r.subjectId,
      name: nameMap.get(r.subjectId) ?? null,
      created_at: r.created_at,
    }));
    return c.json({ logs });
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd flow && npx vitest run tests/unit/node-logs-endpoint.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full flow test suite**

```bash
cd flow && npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/node-logs-endpoint.test.ts
git commit -m "feat(flow): read content flow node-log detail straight from R2, drop D1 content join"
```

---

## Task 5: Pollers — populate `content_url`

**Files:**
- Modify: `link/src/services/pollers/x-posts.ts`
- Modify: `link/src/services/pollers/x-list-posts.ts`
- Modify: `link/src/services/pollers/youtube-content.ts`
- Modify: `link/src/services/tiktok-content-api.ts`
- Modify: `metadata/tiktok.ts`
- Modify: `metadata/props.ts`
- Test: `link/tests/services/pollers/x-list-posts.test.ts`
- Test: `link/tests/services/pollers/youtube-content.test.ts`
- Test: `link/tests/services/tiktok-content-api.test.ts`

**Interfaces:**
- Produces: `resolvedProps.content_url` (and, for TikTok, the raw API field `share_url`) — flows into `payload.content_url`, which Task 3's `emitContentNodeLogs` reads.

- [ ] **Step 1: Add the `content_url` propId to metadata**

`metadata/props.ts` — find:

```typescript
  {
    propId: "content_text",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Content Text", zh: "内容文本" },
  },
```

Add immediately after:

```typescript
  {
    propId: "content_url",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Content URL", zh: "内容链接" },
  },
```

- [ ] **Step 2: Write the failing tests**

In `link/tests/services/pollers/x-list-posts.test.ts`, add (near the existing `"incremental: emits content.created with listId for new list posts"` test):

```typescript
  it("populates content_url as the X status permalink, derived from source_content_id", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "12345", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb, { flowQueue }));

    expect(flowQueue.send.mock.calls[0][0].payload).toMatchObject({ content_url: "https://x.com/i/status/12345" });
  });
```

In `link/tests/services/pollers/youtube-content.test.ts`, add (following the same `vi.spyOn(youtubeApi, "fetchVideoDetails")` + `flowQueue` pattern as the existing `"emits content.created via flowQueue..."` test):

```typescript
  it("populates content_url as the YouTube watch permalink, derived from source_content_id", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid5",
      snippet: { title: "Linked", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT1M" },
    });

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid5");

    expect(flowQueue.send.mock.calls[0][0].payload).toMatchObject({ content_url: "https://www.youtube.com/watch?v=vid5" });
  });
```

`link/tests/services/tiktok-content-api.test.ts` already has an existing test, `"requests the full field list and passes cursor/max_count in the body"`, that asserts the exact `fields` query param via `.toBe(...)` — adding `share_url` to `VIDEO_FIELDS` (Step 7) will make its current expected string stale, so update that assertion in place rather than adding a redundant new test. Find:

```typescript
    expect(calledUrl.searchParams.get("fields")).toBe(
      "id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count"
    );
```

Replace with:

```typescript
    expect(calledUrl.searchParams.get("fields")).toBe(
      "id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count,share_url"
    );
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd link && npx vitest run tests/services/pollers/x-list-posts.test.ts tests/services/pollers/youtube-content.test.ts tests/services/tiktok-content-api.test.ts
```

Expected: FAIL — none of the source files populate `content_url`/`share_url` yet.

- [ ] **Step 4: `x-posts.ts` — add the X permalink fixup**

Find, inside `upsertPage`:

```typescript
    const props = resolveProps(item, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
    // X Articles come back as a tweet with an extra `article` object (see
    // _reference/x/post.json); PropMapping only supports fixed value/dataId extraction,
    // so this presence check stays here rather than in the declarative metadata.
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X", emitFlowEvent);
```

Replace with:

```typescript
    const props = resolveProps(item, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
    // X Articles come back as a tweet with an extra `article` object (see
    // _reference/x/post.json); PropMapping only supports fixed value/dataId extraction,
    // so this presence check stays here rather than in the declarative metadata.
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    // X's tweet.fields has no permalink field; x.com/i/status/{id} is the official,
    // username-independent status URL format — same reasoning as the article fixup above.
    props.content_url = `https://x.com/i/status/${props.source_content_id}`;
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X", emitFlowEvent);
```

- [ ] **Step 5: `x-list-posts.ts` — add the same fixup**

Find, inside `upsertPage`:

```typescript
    const props = resolveProps(item, LIST_POSTS_METADATA.contentProps, LIST_POSTS_METADATA.linkPrefix);
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    const sourceContentId = String(props.source_content_id ?? "");
```

Replace with:

```typescript
    const props = resolveProps(item, LIST_POSTS_METADATA.contentProps, LIST_POSTS_METADATA.linkPrefix);
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    // X's tweet.fields has no permalink field; x.com/i/status/{id} is the official,
    // username-independent status URL format.
    props.content_url = `https://x.com/i/status/${props.source_content_id}`;
    const sourceContentId = String(props.source_content_id ?? "");
```

- [ ] **Step 6: `youtube-content.ts` — add the YouTube permalink fixup**

Find, inside `ingestYouTubeVideo`:

```typescript
  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
```

Replace with:

```typescript
  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
```

- [ ] **Step 7: `tiktok-content-api.ts` — request `share_url`**

Find:

```typescript
const VIDEO_FIELDS = [
  "id",
  "video_description",
  "create_time",
  "cover_image_url",
  "duration",
  "height",
  "width",
  "title",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
].join(",");
```

Replace with:

```typescript
const VIDEO_FIELDS = [
  "id",
  "video_description",
  "create_time",
  "cover_image_url",
  "duration",
  "height",
  "width",
  "title",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
  "share_url",
].join(",");
```

- [ ] **Step 8: `metadata/tiktok.ts` — map `share_url` to `content_url`**

Find, in the `video.list` entry's `contentProps`:

```typescript
      { propId: "content_text", dataId: "{linkPrefix}.video_description" },
```

Add immediately after:

```typescript
      { propId: "content_url", dataId: "{linkPrefix}.share_url" },
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd link && npx vitest run tests/services/pollers/x-list-posts.test.ts tests/services/pollers/youtube-content.test.ts tests/services/tiktok-content-api.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run the full link test suite**

```bash
cd link && npm test
```

Expected: all pass (also exercises `x-posts.test.ts`, which covers `own:get-posts` — confirm it still passes with the new `content_url` fixup in `x-posts.ts`).

- [ ] **Step 11: Commit**

```bash
git add link/src/services/pollers/x-posts.ts link/src/services/pollers/x-list-posts.ts link/src/services/pollers/youtube-content.ts link/src/services/tiktok-content-api.ts metadata/tiktok.ts metadata/props.ts link/tests/services/pollers/x-list-posts.test.ts link/tests/services/pollers/youtube-content.test.ts link/tests/services/tiktok-content-api.test.ts
git commit -m "feat(link): populate content_url for X/YouTube/TikTok content triggers"
```

---

## Task 6: Frontend — content-domain drawer redesign

**Files:**
- Modify: `flow/frontend/lib/api.ts`
- Modify: `flow/frontend/pages/AnalyticsPage.tsx`

**Interfaces:**
- Consumes: Task 4's `GET /api/flows/:id/nodes/:nodeId/logs` response shape.

- [ ] **Step 1: Update `api.ts`'s `nodeLogs` return type**

Find:

```typescript
    nodeLogs: (flowId: string, nodeId: string) =>
      request<{ logs: { user_id: string; name: string | null; created_at: string }[] }>(
        `/api/flows/${flowId}/nodes/${nodeId}/logs`
      ),
```

Replace with:

```typescript
    nodeLogs: (flowId: string, nodeId: string) =>
      request<{
        logs: {
          user_id?: string;
          name?: string | null;
          content_id?: string;
          created_at: string;
          outcome?: string;
          title?: string | null;
          content_text?: string | null;
          content_url?: string | null;
        }[];
      }>(`/api/flows/${flowId}/nodes/${nodeId}/logs`),
```

- [ ] **Step 2: Rewrite `AnalyticsPage.tsx`**

Read the current full file first (`flow/frontend/pages/AnalyticsPage.tsx`, 141 lines) to confirm no other change has landed on it since this plan was written, then replace its entire content with:

```tsx
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ReactFlowProvider, ReactFlow, Background, Controls } from "@xyflow/react";
import { nodeTypes } from "../nodes";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { api, type FlowDetail } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { TooltipProvider } from "../../../shared/frontend/ui/tooltip";

interface NodeLogEntry {
  user_id?: string;
  name?: string | null;
  content_id?: string;
  created_at: string;
  outcome?: string;
  title?: string | null;
  content_text?: string | null;
  content_url?: string | null;
}

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, { enter: number; exit: number }>>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeLogs, setNodeLogs] = useState<NodeLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.flows.get(id),
      api.flows.analytics(id),
    ]).then(([flowRes, analyticsRes]) => {
      setFlow(flowRes.flow);
      setCounts(analyticsRes.nodes || {});
    }).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id || !selectedNode) { setNodeLogs([]); return; }
    setLogsLoading(true);
    api.flows.nodeLogs(id, selectedNode)
      .then((res) => setNodeLogs(res.logs))
      .catch(() => setNodeLogs([]))
      .finally(() => setLogsLoading(false));
  }, [id, selectedNode]);

  if (loading) return <div className="flex items-center justify-center h-screen"><Skeleton className="h-8 w-48" /></div>;
  if (!flow) return <div className="flex items-center justify-center h-screen text-destructive">Flow not found</div>;

  const graph = JSON.parse(flow.graph_json || '{"nodes":[],"edges":[]}');
  const isContentDomain = graph.nodes.some((n: any) => n.type === "xContentTrigger" || n.type === "youtubeContentTrigger");
  const nodes = graph.nodes.map((n: any) => ({
    ...n,
    draggable: false,
    selectable: true,
    data: { ...n.data, _analytics: counts[n.id] || { enter: 0, exit: 0 } },
  }));
  const edges = graph.edges;

  const handleUnpublish = async () => {
    if (!id) return;
    await api.flows.unpublish(id);
    navigate(`/flows/${id}`);
  };

  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <div className="h-screen flex flex-col">
          <div className="flex items-center h-12 px-4 border-b border-border bg-background gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>← Back</Button>
            <span className="text-sm font-medium flex-1">{flow.name}</span>
            <Button variant="outline" size="sm" onClick={handleUnpublish}>Unpublish</Button>
          </div>
          <div className="flex-1 relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={true}
              onNodeClick={(_, node) => setSelectedNode(node.id)}
              onPaneClick={() => setSelectedNode(null)}
              fitView
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>

            {/* Right drawer */}
            {selectedNode && (() => {
              const node = nodes.find((n: any) => n.id === selectedNode);
              const nodeType = node?.type || "";
              const nodeData = node?.data || {};
              let nodeName = "";
              if (nodeType === "xContentTrigger") nodeName = NODE_TYPE_REGISTRY.xContentTrigger.label!;
              else if (nodeType === "youtubeContentTrigger") nodeName = NODE_TYPE_REGISTRY.youtubeContentTrigger.label!;
              else if (nodeType === "xTrigger") nodeName = (nodeData.eventType as string) || "Trigger";
              else if (nodeType === "action") {
                const actionType = nodeData.actionType as string;
                nodeName = actionType === "xAction" ? "X Action"
                  : actionType === "addToList" ? "Add to List"
                  : actionType === "xContentAction" ? NODE_TYPE_REGISTRY.xContentAction.label!
                  : actionType === "tiktokContentAction" ? NODE_TYPE_REGISTRY.tiktokContentAction.label!
                  : actionType === "youtubeContentAction" ? NODE_TYPE_REGISTRY.youtubeContentAction.label!
                  : actionType === "videoAction" ? NODE_TYPE_REGISTRY.videoAction.label!
                  : "Action";
              }
              else if (nodeType === "wait") nodeName = `Wait ${nodeData.duration} ${nodeData.unit}`;
              else if (nodeType === "waitForEvent") nodeName = `Wait for Event`;
              else nodeName = nodeType;
              return (
              <div className="absolute right-0 top-0 h-full w-96 bg-background border-l border-border shadow-lg p-4 overflow-y-auto z-10">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{nodeName}</h3>
                    <p className="text-xs text-muted-foreground">Node Analytics</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSelectedNode(null)}>×</Button>
                </div>
                <div className="mb-4">
                  <p className="text-2xl font-bold text-primary">{counts[selectedNode]?.enter || 0}</p>
                  <p className="text-xs text-muted-foreground">Entered</p>
                </div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">{isContentDomain ? "Content Entered" : "Users Entered"}</h4>
                {logsLoading ? (
                  <p className="text-xs text-muted-foreground">Loading...</p>
                ) : nodeLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">{isContentDomain ? "No content has entered this node yet." : "No users have entered this node yet."}</p>
                ) : isContentDomain ? (
                  <ul className="space-y-3">
                    {nodeLogs.map((log, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 text-xs border-b border-border pb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate">
                            {log.title || (log.content_text ? `${log.content_text.slice(0, 5)}…` : "(no content)")}
                          </p>
                          {log.content_url && (
                            <a href={log.content_url} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">
                              {log.content_url}
                            </a>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-muted-foreground whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</p>
                          {log.outcome === "failed" && <p className="text-destructive font-medium">Failed</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-2">
                    {nodeLogs.map((log, i) => (
                      <li key={i} className="flex items-center justify-between text-xs">
                        <span className="text-foreground">{log.name || log.user_id}</span>
                        <span className="text-muted-foreground">{new Date(log.created_at).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              );
            })()}
          </div>
        </div>
      </ReactFlowProvider>
    </TooltipProvider>
  );
}
```

Note what was intentionally dropped from the previous version: the dead `{/* Node count overlays */}` block (it rendered nothing — `style={{ display: "none" }}` with an empty comment body) is removed as unreachable/unused code encountered while touching this file.

- [ ] **Step 3: Start the dev server and verify in browser**

```bash
cd flow && wrangler dev --env dev
```

Open a content flow's analytics page (a flow containing `xContentTrigger`/`youtubeContentTrigger`) in the browser. Click the trigger node: confirm the drawer shows a two-column layout with content preview (title-or-truncated-text + link) on the left and timestamp on the right. Click an `xContentAction`/`tiktokContentAction`/`videoAction` node that has a failed execution: confirm "Failed" appears in red under the timestamp. Click a node in a **user**-domain flow: confirm the drawer still renders the original single-column `name`/timestamp list (unchanged).

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/lib/api.ts flow/frontend/pages/AnalyticsPage.tsx
git commit -m "feat(flow): redesign content flow analytics drawer with content preview + failed status"
```

---

## Final Verification

- [ ] Run `cd flow && npm test` — all pass.
- [ ] Run `cd link && npm test` — all pass.
- [ ] Confirm Task 1's production pipeline rebuild (Step 5) has actually been executed and verified in production before this branch is considered fully deployed — the application code in Tasks 2–5 will silently no-op the new columns against production until that infra step lands.
