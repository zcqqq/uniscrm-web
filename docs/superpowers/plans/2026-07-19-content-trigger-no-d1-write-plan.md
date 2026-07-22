# Content-Trigger No-D1-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop writing a `content` D1 row (and its `pipelineContent` R2/analytics side effect) for content ingested purely to trigger a flow — replace the D1-row-existence dedup check with a lightweight dedup table, and remove the now-unusable `updateContentStatus` flow action.

**Architecture:** A new tenant-scoped `content_trigger_dedup` table (id-only, no content fields) replaces the `content` table's existence check as the idempotency guard for trigger-sourced ingestion. `ContentService` gains two new methods (`recordTriggerContentSeen`, `emitContentTriggerEvent`) that trigger-source pollers call instead of `upsertContentFromMetadata`. `updateContentStatus` — which only ever updated a `content` row that trigger-sourced flows no longer have — is deleted from the node registry, engine, execution layer, prompt generator, and every frontend surface.

**Tech Stack:** Cloudflare Workers, Hono, D1 (via `TenantDataDB` REST client), Vitest.

## Global Constraints

- Scope: only `flowType: "trigger"` content sources stop writing to `content`/`pipelineContent`. Today that's `metadata/x-byok.ts`'s `get-list-posts` only — `metadata/youtube.ts`'s `watch:get-videos` gets `flowType: "trigger"` added by the companion YouTube plan, not this one; this plan's `youtube-content.ts` changes are limited to what's needed so that plan can build on it (none — see Task 3 note).
- `metadata/x-byok.ts`'s `own:get-posts` and `metadata/tiktok.ts`'s `video.list` (own-content analytics pollers) are **not touched** — they keep calling `upsertContentFromMetadata` unchanged, D1 write and `pipelineContent` write both intact.
- `ContentService.upsertContentFromMetadata` and `ContentService.recordPublishedContent` are **not modified** — same signatures, same behavior, same callers (minus `x-list-posts.ts`, which stops calling `upsertContentFromMetadata`).
- The dedup table lives in the **tenant DB** (same D1 database as `content`), provisioned via `admin/src/services/tenant-init-sql.ts` (new tenants) and `operation/migrations/` (existing tenants) — not `link`'s own `LINK_DB`.
- Accepted, intentional regressions (do not attempt to work around; documented here per the approved spec): X List Posts content (a) no longer appears in the `analytics` module's `uniscrm.content` dashboard, and (b) no longer gets a Vectorize embedding (nothing in the codebase currently queries embeddings keyed to `content` rows for search — confirmed via repo-wide grep — so this has no discoverable functional impact today, but is called out in case a future feature assumes otherwise).

---

### Task 1: `content_trigger_dedup` tenant-DB table

**Files:**
- Modify: `admin/src/services/tenant-init-sql.ts` (new-tenant provisioning)
- Create: `operation/migrations/0004-content-trigger-dedup.ts` (existing-tenant rollout)
- Create: `operation/migrations/0004-content-trigger-dedup.test.ts`

**Interfaces:**
- Produces: table `content_trigger_dedup(channel_id TEXT, secondary_id TEXT, source_content_id TEXT, tenant_id INTEGER, seen_at TEXT, PRIMARY KEY(channel_id, secondary_id, source_content_id))` — consumed by Task 2's `ContentService.recordTriggerContentSeen`.

- [ ] **Step 1: Add the table to `TENANT_DB_INIT_SQL`**

In `admin/src/services/tenant-init-sql.ts`, add a new array entry immediately after the existing `content_flow_counts` entry (before the closing `];` at line 101):

```ts
  `CREATE TABLE IF NOT EXISTS content_trigger_dedup (
    channel_id TEXT NOT NULL,
    secondary_id TEXT NOT NULL DEFAULT '',
    source_content_id TEXT NOT NULL,
    tenant_id INTEGER NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, secondary_id, source_content_id)
  )`,
```

- [ ] **Step 2: Write the migration for existing tenant DBs**

Create `operation/migrations/0004-content-trigger-dedup.ts`:

```ts
import type { TenantMigration } from "./types.ts";

export const migration: TenantMigration = {
  name: "0004-content-trigger-dedup",
  async apply(tdb) {
    await tdb.run(`CREATE TABLE IF NOT EXISTS content_trigger_dedup (
      channel_id TEXT NOT NULL,
      secondary_id TEXT NOT NULL DEFAULT '',
      source_content_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, secondary_id, source_content_id)
    )`);
  },
};
```

- [ ] **Step 3: Write the migration test**

Create `operation/migrations/0004-content-trigger-dedup.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { migration } from "./0004-content-trigger-dedup.ts";

function createMockTdb() {
  return {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    query: vi.fn().mockResolvedValue([]),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("0004-content-trigger-dedup migration", () => {
  it("has the expected name", () => {
    expect(migration.name).toBe("0004-content-trigger-dedup");
  });

  it("creates content_trigger_dedup with an IF NOT EXISTS guard", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);

    expect(tdb.run).toHaveBeenCalledTimes(1);
    const [sql] = tdb.run.mock.calls[0];
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS content_trigger_dedup");
    expect(sql).toContain("PRIMARY KEY (channel_id, secondary_id, source_content_id)");
  });

  it("is safely re-runnable (idempotent CREATE, no error on a second apply against the same mock)", async () => {
    const tdb = createMockTdb();
    await migration.apply(tdb as any);
    await expect(migration.apply(tdb as any)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 4: Run the migration test**

Run: `cd operation && npx vitest run migrations/0004-content-trigger-dedup.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add admin/src/services/tenant-init-sql.ts operation/migrations/0004-content-trigger-dedup.ts operation/migrations/0004-content-trigger-dedup.test.ts
git commit -m "feat(admin,operation): add content_trigger_dedup tenant-DB table"
```

---

### Task 2: `ContentService.recordTriggerContentSeen` + `emitContentTriggerEvent`

**Files:**
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts`

**Interfaces:**
- Consumes: `content_trigger_dedup` table from Task 1.
- Produces:
  - `recordTriggerContentSeen(channelId: string, secondaryId: string, sourceContentId: string): Promise<boolean>` — `true` if newly recorded (not seen before), `false` if already present.
  - `emitContentTriggerEvent(channelId: string, channelType: ChannelType, secondaryFieldName: "listId" | "subscriptionChannelId", secondaryValue: string, resolvedProps: Record<string, unknown>): Promise<void>` — sends the `content.created` flow-queue message with a freshly generated `contentId` (opaque UUID, not a D1 row id).
  - Consumed by Task 3 (`x-list-posts.ts`) and by the companion YouTube plan's ingestion path.

- [ ] **Step 1: Write the failing tests**

Append to `link/tests/services/content.test.ts` (after the closing `});` of the `recordPublishedContent` describe block, i.e. at end of file):

```ts

describe("ContentService.recordTriggerContentSeen", () => {
  function createMockTenantDb() {
    return {
      query: vi.fn(),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
      batch: vi.fn(),
      getDbId: vi.fn().mockReturnValue("db-1"),
    };
  }

  it("inserts into content_trigger_dedup and returns true when the row is new", async () => {
    const tenantDb = createMockTenantDb();
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    const isNew = await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO content_trigger_dedup"),
      ["chan1", "listA", "t1", 42, expect.any(String)]
    );
  });

  it("returns false when the row already existed (changes: 0)", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.run.mockResolvedValue({ changes: 0 });
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    const isNew = await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(isNew).toBe(false);
  });

  it("accepts an empty secondaryId for trigger types with no secondary dimension", async () => {
    const tenantDb = createMockTenantDb();
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    await service.recordTriggerContentSeen("chan1", "", "t1");

    expect(tenantDb.run).toHaveBeenCalledWith(expect.any(String), ["chan1", "", "t1", 42, expect.any(String)]);
  });

  it("does not touch the content table or pipelineContent", async () => {
    const tenantDb = createMockTenantDb();
    const pipelineContent = { send: vi.fn() };
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42, pipelineContent as any);

    await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(tenantDb.run).toHaveBeenCalledTimes(1);
    expect(pipelineContent.send).not.toHaveBeenCalled();
  });
});

describe("ContentService.emitContentTriggerEvent", () => {
  it("sends content.created with a freshly generated contentId and the named secondary field", async () => {
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService({} as any, {} as any, {} as any, 42, undefined, flowQueue as any);

    await service.emitContentTriggerEvent("chan1", "X", "listId", "listA", { content_type: "TWEET" });

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    const [msg] = flowQueue.send.mock.calls[0];
    expect(msg).toMatchObject({
      tenantId: "42",
      eventType: "content.created",
      channelId: "chan1",
      listId: "listA",
      payload: { channel_type: "X", content_type: "TWEET" },
    });
    expect(typeof msg.contentId).toBe("string");
    expect(msg.contentId.length).toBeGreaterThan(0);
  });

  it("omits the secondary field entirely when secondaryValue is empty (not just undefined)", async () => {
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService({} as any, {} as any, {} as any, 42, undefined, flowQueue as any);

    await service.emitContentTriggerEvent("chan1", "YOUTUBE", "subscriptionChannelId", "", { content_type: "VIDEO" });

    const [msg] = flowQueue.send.mock.calls[0];
    expect("subscriptionChannelId" in msg).toBe(false);
  });

  it("does not throw when no flowQueue was provided", async () => {
    const service = new ContentService({} as any, {} as any, {} as any, 42);

    await expect(
      service.emitContentTriggerEvent("chan1", "X", "listId", "listA", {})
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/content.test.ts -t "recordTriggerContentSeen|emitContentTriggerEvent"`
Expected: FAIL — `service.recordTriggerContentSeen is not a function` / `service.emitContentTriggerEvent is not a function`

- [ ] **Step 3: Implement the two methods**

In `link/src/services/content.ts`, add after `recordPublishedContent` (which ends around line 271, right before `async list(`):

```ts
  async recordTriggerContentSeen(
    channelId: string,
    secondaryId: string,
    sourceContentId: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.tenantDb.run(
      `INSERT OR IGNORE INTO content_trigger_dedup (channel_id, secondary_id, source_content_id, tenant_id, seen_at) VALUES (?, ?, ?, ?, ?)`,
      [channelId, secondaryId, sourceContentId, this.tenantId, now]
    );
    return result.changes > 0;
  }

  async emitContentTriggerEvent(
    channelId: string,
    channelType: ChannelType,
    secondaryFieldName: "listId" | "subscriptionChannelId",
    secondaryValue: string,
    resolvedProps: Record<string, unknown>
  ): Promise<void> {
    if (!this.flowQueue) return;
    await this.flowQueue.send({
      tenantId: String(this.tenantId),
      eventType: "content.created",
      contentId: crypto.randomUUID(),
      channelId,
      ...(secondaryValue ? { [secondaryFieldName]: secondaryValue } : {}),
      payload: { channel_type: channelType, ...resolvedProps },
    }).catch((err) => {
      console.error(JSON.stringify({ event: "content_trigger_queue_send_error", channelId, error: String(err) }));
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: all passed (existing `upsertContentFromMetadata`/`recordPublishedContent` tests unaffected, new ones passing)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "feat(link): add ContentService.recordTriggerContentSeen/emitContentTriggerEvent"
```

---

### Task 3: `x-list-posts.ts` switches to the new dedup/emit path

**Files:**
- Modify: `link/src/services/pollers/x-list-posts.ts`
- Test: `link/tests/services/pollers/x-list-posts.test.ts`

**Interfaces:**
- Consumes: `ContentService.recordTriggerContentSeen`/`emitContentTriggerEvent` from Task 2.
- Produces: no new exports — `runListPostsPoller`'s public signature is unchanged; only its internal `upsertPage` helper's implementation changes.

- [ ] **Step 1: Update the failing/changed tests first**

In `link/tests/services/pollers/x-list-posts.test.ts`, replace the `createMockTenantDb` helper (lines 13-20) — no change needed there, it already returns `{ changes: 1 }` by default, which is what `recordTriggerContentSeen` needs to report "new" — but replace the two assertions that referenced `upsertContentFromMetadata`'s SQL shape:

Replace (lines 76-93, the seed-phase test's assertion block):
```ts
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tenantDb.run).toHaveBeenCalledTimes(1);
    expect(flowQueue.send).not.toHaveBeenCalled();
```
with:
```ts
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Seed phase still records into content_trigger_dedup (so the next incremental poll
    // doesn't see this backlog as new and flood the flow) — it just never emits.
    expect(tenantDb.run).toHaveBeenCalledTimes(1);
    expect(tenantDb.run.mock.calls[0][0]).toContain("INSERT OR IGNORE INTO content_trigger_dedup");
    expect(flowQueue.send).not.toHaveBeenCalled();
```

Replace the test at lines 121-131 (`"passes listId through to upsertContentFromMetadata..."`) entirely with:
```ts
  it("passes listId as the dedup table's secondary_id", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, tenantDb));

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall![1]).toEqual(["chan1", "listA", "t1", 1, expect.any(String)]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/pollers/x-list-posts.test.ts`
Expected: FAIL — the updated assertions don't match current `upsertContentFromMetadata`-based SQL

- [ ] **Step 3: Implement the poller change**

In `link/src/services/pollers/x-list-posts.ts`, replace `upsertPage` (lines 56-73):

```ts
async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  channelId: string,
  listId: string,
  emitFlowEvent: boolean
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, LIST_POSTS_METADATA.contentProps, LIST_POSTS_METADATA.linkPrefix);
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    const sourceContentId = String(props.source_content_id ?? "");
    // ALWAYS record, including during the seed phase (emitFlowEvent=false) — the dedup table
    // is the only place "already seen" state lives now, so skipping the record during seed
    // would make the first incremental poll see the whole seeded backlog as new and flood the
    // flow with duplicate triggers.
    const isNew = await contentService.recordTriggerContentSeen(channelId, listId, sourceContentId);
    if (isNew) newCount++;
    if (isNew && emitFlowEvent) {
      await contentService.emitContentTriggerEvent(channelId, "X", "listId", listId, props);
    }
  }
  return newCount;
}
```

Remove the now-unused `import { ContentService } from "../content";` type-only usage check — `ContentService` is still imported and used as a parameter type, no import change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/pollers/x-list-posts.test.ts`
Expected: all passed

- [ ] **Step 5: Run the full link test suite to check for collateral breakage**

Run: `cd link && npx vitest run`
Expected: all passed (no other file calls `x-list-posts.ts`'s internals directly)

- [ ] **Step 6: Commit**

```bash
git add link/src/services/pollers/x-list-posts.ts link/tests/services/pollers/x-list-posts.test.ts
git commit -m "feat(link): x-list-posts uses recordTriggerContentSeen/emitContentTriggerEvent instead of D1 upsert"
```

**Note for the companion YouTube plan:** this task does not touch `link/src/services/pollers/youtube-content.ts` or `link/src/webhook-youtube.ts` — those changes belong to the YouTube Channel→Subscription plan, which depends on this task's `recordTriggerContentSeen`/`emitContentTriggerEvent` methods existing.

---

### Task 4: Remove `updateContentStatus` — registry, engine, execution, prompt

**Files:**
- Modify: `flow/nodeTypeRegistry.ts`
- Modify: `flow/src/engine.ts`
- Modify: `flow/src/index.ts`
- Modify: `flow/src/generate-prompt.ts`
- Test: `flow/tests/unit/node-type-registry.test.ts`
- Test: `flow/tests/unit/generate-prompt.test.ts`

**Interfaces:**
- Produces: `NODE_TYPE_REGISTRY` no longer has an `updateContentStatus` key; `CONTENT_FLOW_SIDEBAR_ORDER` no longer lists it. Consumed by Task 5's frontend cleanup and by every test file listed there.

- [ ] **Step 1: Remove the registry entry**

In `flow/nodeTypeRegistry.ts`, delete lines 213-222 (the entire `updateContentStatus: { ... },` block, including its trailing blank line before the `// --- shared across both domains ---` comment):

```ts
  updateContentStatus: {
    reactFlowType: "action",
    label: "Update Content Status",
    description: "Set this content's status",
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For status-update actions: data: { actionType: "updateContentStatus", status: "" }
   - status must be set by the user afterward via the Inspector to "published" or "ignored" — leave it blank ("") here. No branching.`,
  },

```

- [ ] **Step 2: Remove it from the content sidebar order**

In `flow/nodeTypeRegistry.ts`, change:
```ts
export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "updateContentStatus",
  "wait", "timeCondition", "abSplit", "webhook",
];
```
to:
```ts
export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction",
  "wait", "timeCondition", "abSplit", "webhook",
];
```

- [ ] **Step 3: Remove the engine.ts branch**

In `flow/src/engine.ts`, delete lines 268-270:
```ts
  if (actionType === "updateContentStatus") {
    actionData.status = targetNode.data.status as string;
  }
```

- [ ] **Step 4: Remove the execution branch**

In `flow/src/index.ts`, delete lines 434-440 (the `} else if (action.type === "updateContentStatus" ...) { ... }` block), leaving the preceding `if`/`else if` chain's closing brace intact — i.e. change:
```ts
    } else if (action.type === "updateContentStatus" && action.status) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        await tdb.run(`UPDATE content SET status = ? WHERE id = ?`, [action.status as string, contentId]);
      }
    }
```
to:
```ts
    }
```

- [ ] **Step 5: Remove it from the generate-prompt content-domain rules text**

In `flow/src/generate-prompt.ts` line 64, change:
```ts
- Only use xContentTrigger, youtubeContentTrigger, wait, timeCondition, abSplit, webhook, and action (with actionType "xContentAction", "tiktokContentAction", or "updateContentStatus") node types. Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, changeUserProps, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
```
to:
```ts
- Only use xContentTrigger, youtubeContentTrigger, wait, timeCondition, abSplit, webhook, and action (with actionType "xContentAction" or "tiktokContentAction") node types. Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, changeUserProps, or an action with actionType "xAction"/"addToList"/"updateContentStatus" — those belong to a different flow domain or no longer exist.
```

- [ ] **Step 6: Update `node-type-registry.test.ts`**

In `flow/tests/unit/node-type-registry.test.ts`:

Line 18 — change:
```ts
      "addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus",
```
to:
```ts
      "addToList", "xAction", "xContentAction", "tiktokContentAction",
```

Line 49 — change:
```ts
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"]) {
```
to:
```ts
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction"]) {
```

Lines 189-192 — change:
```ts
      [
        "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "updateContentStatus",
        "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
```
to:
```ts
      [
        "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction",
        "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
```

- [ ] **Step 7: Update `generate-prompt.test.ts`**

In `flow/tests/unit/generate-prompt.test.ts` line 46, delete:
```ts
    expect(prompt).toContain('actionType: "updateContentStatus"');
```

- [ ] **Step 8: Run the affected unit tests**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts tests/unit/generate-prompt.test.ts`
Expected: all passed

(Do not run the full `flow` suite yet — `engine.test.ts` and the execution-layer tests still reference `updateContentStatus` fixtures and will fail until Task 5.)

- [ ] **Step 9: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/src/engine.ts flow/src/index.ts flow/src/generate-prompt.ts flow/tests/unit/node-type-registry.test.ts flow/tests/unit/generate-prompt.test.ts
git commit -m "feat(flow): remove updateContentStatus from registry, engine, execution, and prompt generation"
```

---

### Task 5: Remove `updateContentStatus` from the frontend, and fix its test fixtures

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/nodes/ActionNode.tsx`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/pages/FlowsPage.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/tests/unit/engine.test.ts`
- Modify: `flow/tests/unit/content-action-branch-node-logs.test.ts`
- Modify: `flow/tests/unit/queue-content.test.ts`
- Modify: `flow/tests/unit/scheduled-content.test.ts`
- Modify: `flow/tests/unit/emit-content-node-logs.test.ts`

**Interfaces:**
- Consumes: Task 4's registry/engine/execution changes.

- [ ] **Step 1: Remove the Inspector routing and component**

In `flow/frontend/components/Inspector.tsx`, delete lines 515-517:
```ts
  if (actionType === "updateContentStatus") {
    return <UpdateContentStatusInspector nodeId={nodeId} data={data} />;
  }

```
and delete the `UpdateContentStatusInspector` function (lines 819-838):
```tsx
function UpdateContentStatusInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.updateContentStatus.label}</h4>
      <div>
        <Label className="text-xs block mb-1">New Status</Label>
        <Select
          value={data.status || ""}
          onChange={(e: SelectChange) => updateNodeData(nodeId, { status: e.target.value })}
          className="w-full text-sm"
        >
          <option value="">Select status...</option>
          <option value="published">Published</option>
          <option value="ignored">Ignored</option>
        </Select>
      </div>
    </div>
  );
}

```

- [ ] **Step 2: Remove the ActionNode.tsx branch**

In `flow/frontend/nodes/ActionNode.tsx`, delete lines 45-49:
```ts
  } else if (actionType === "updateContentStatus") {
    const status = data.status as string;
    label = NODE_TYPE_REGISTRY.updateContentStatus.label!;
    description = status ? `Set status to "${status}"` : "Select a status...";
    icon = "🏷️";
```
leaving the `} else {` fallback (currently line 50) as the new end of that `else if` chain — i.e. the block becomes:
```ts
  } else if (actionType === "tiktokContentAction") {
    const channelId = data.channelId as string;
    label = NODE_TYPE_REGISTRY.tiktokContentAction.label!;
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = "📸";
  } else {
    label = "Action";
    description = "Unknown action";
    icon = "⚡";
  }
```

- [ ] **Step 3: Remove the Sidebar.tsx entry**

In `flow/frontend/components/Sidebar.tsx`, delete lines 134-139:
```ts
  if (visible("updateContentStatus")) {
    actionItems.push({
      key: "updateContentStatus",
      el: <DraggableItem key="updateContentStatus" type="updateContentStatus" label={NODE_TYPE_REGISTRY.updateContentStatus.label!} description={NODE_TYPE_REGISTRY.updateContentStatus.description!} color="border-accent bg-accent/50" icon="🏷️" />,
    });
  }

```

- [ ] **Step 4: Remove the FlowsPage.tsx icon branch**

In `flow/frontend/pages/FlowsPage.tsx`, delete line 32:
```ts
    if (at === "updateContentStatus") return ListIcon;
```

- [ ] **Step 5: Remove it from flow-editor.ts's action types and default-data branch**

In `flow/frontend/store/flow-editor.ts` line 45, change:
```ts
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"];
```
to:
```ts
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "tiktokContentAction"];
```

Delete lines 145-146:
```ts
      } else if (type === "updateContentStatus") {
        data = { actionType: type, status: "" };
```
leaving the `else { throw new Error(...) }` fallback intact — i.e.:
```ts
      } else if (type === "tiktokContentAction") {
        data = {
          actionType: type, channelId: "", prompts: {},
          textProvider: "default", textSkillId: "none",
          imageCount: 1, imageProvider: "default", imageSkillId: "none",
        };
      } else {
        throw new Error(`Unexpected action type: ${type}`);
      }
```

- [ ] **Step 6: Fix `engine.test.ts`'s fixture with an inert placeholder actionType**

`updateContentStatus` was the only content-domain action with `hasBranches: false` and zero execution side effects (per `flow/src/engine.ts:245`, `hasBranches` is computed as `actionType === "xAction" || actionType === "xContentAction" || actionType === "tiktokContentAction"` — any *other* string, including an unrecognized one, already evaluates to `false`). After Task 4 removes `updateContentStatus`'s branch from `index.ts`'s `executeContentActions` if/else-if chain (`flow/src/index.ts:300-441`), that chain has no trailing `else`, so an unrecognized `actionType` simply falls through and executes as a true no-op — reproducing `updateContentStatus`'s old inert-leaf behavior exactly, without needing a real registered action type. Use the literal string `"noopLeaf"` (not a registered node type; exists only in these test fixtures) everywhere a test previously used `updateContentStatus` as a terminal, non-branching, no-side-effect action.

In `flow/tests/unit/engine.test.ts`, replace every occurrence of `"updateContentStatus"` with `"noopLeaf"` and every `status: "published"`/`status: "ignored"` field on those same nodes with `marker: "published"`/`marker: "ignored"` respectively (keeping each pair of sibling branch nodes on distinct values so existing assertions that check both branches produced *different* action data continue to discriminate them — the field name itself doesn't matter since nothing in `flow/src/engine.ts`'s `buildActionData` recognizes `"noopLeaf"`, so it's carried through only as opaque `targetNode.data`... actually `buildActionData` only copies fields it explicitly recognizes by actionType, so a `marker` field on an unrecognized actionType is simply *not* copied onto `actionData` — adjust the existing assertions that check `status: "published"` on the action result: those assertions must instead just check `type: "noopLeaf"` and `nodeId`, since there is no equivalent per-action distinguishing field anymore). Concretely:
- Line 12: `{ id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },` → `{ id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },`
- Line 22: `expect(result.actions[0]).toMatchObject({ type: "updateContentStatus" });` → `expect(result.actions[0]).toMatchObject({ type: "noopLeaf" });`
- Lines 158-174 (the `"collects an updateContentStatus action and continues traversal past it"` test): rename the test title (line 158) to `"collects a noopLeaf action and continues traversal past it"`. Change line 162 from `{ id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },` to `{ id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },`. Change line 163 from `{ id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 0 } },` to `{ id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },`. Change lines 172-173 from `{ type: "updateContentStatus", nodeId: "a1", hasBranches: false, status: "published" },` / `{ type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "ignored" },` to `{ type: "noopLeaf", nodeId: "a1", hasBranches: false },` / `{ type: "noopLeaf", nodeId: "a2", hasBranches: false },`.
- Lines 226-239 (`describe("resumeFromNode: action branch targets get full actionData")`, first test `"populates status on an updateContentStatus branch target (not just {type})"`): this test's entire point is proving a per-actionType field (`status`) survives onto the action result — `noopLeaf` carries no such field by design (nothing in `buildActionData` recognizes it), so delete this test entirely (lines 227-239, from `it("populates status...` through its closing `});`). The same guarantee — a per-actionType field survives `resumeFromNode` — is already proven for `addToList`'s `listId` field by the next test (line 256 in the current file, `{ type: "addToList", nodeId: "a3", hasBranches: false, listId: "l1" }`), so nothing is lost.
- Lines 241-258 (the following test, `"continues traversal past a non-branching action branch target"`): its point is that traversal continues past a2 to reach a3 — not what specific data a2 carries. Change line 245 from `{ id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },` to `{ id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },`, and change line 255 from `{ type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "published" },` to `{ type: "noopLeaf", nodeId: "a2", hasBranches: false },` — the following line's `addToList`/`listId: "l1"` assertion for a3 is unchanged.

- [ ] **Step 7: Run `engine.test.ts`**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: all passed

- [ ] **Step 8: Fix `content-action-branch-node-logs.test.ts` with the same inert `noopLeaf` swap**

a2/a3 here are downstream leaves (no outgoing edges) of a1's real `xContentAction` branch resolution — the test's point is that node-log emission for whichever leaf is reached (a2 on success, a3 on failure) is correct, not what a2/a3 themselves do. Using `xContentAction` for them would make them *also* execute (a real branching action, firing `fetch` again and attempting its own branch resolution with no downstream edges to resolve to) — untested, unnecessary behavior this test was never exercising before. Use the same inert `"noopLeaf"` actionType from Step 6 instead: no execution side effects, no extra `fetch` call, no extra `pipelineSend`/`content_flow_executions` row — behaviorally identical to the old `updateContentStatus` leaves for every assertion in this file.

In `flow/tests/unit/content-action-branch-node-logs.test.ts`, change lines 22-23 from:
```ts
    { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },
    { id: "a3", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 100 } },
```
to:
```ts
    { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
    { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
```
Delete the now-inaccurate comment on lines 72-73 (`// updateContentStatus (a2/a3) queries env.WEB_DB.tenants and no-ops when no matching row exists...`) and the `env.WEB_DB` `tenants` table creation block (lines 74-79) inside `setupSchema()` — `noopLeaf` doesn't touch `WEB_DB` at all (it isn't recognized by any branch in `executeContentActions`, so nothing queries `WEB_DB.tenants` for it). Run `grep -n "WEB_DB" flow/tests/unit/content-action-branch-node-logs.test.ts` after this edit to confirm zero remaining references before deleting the block — if any remain, keep the `tenants` table creation and only delete the comment.

- [ ] **Step 9: Run `content-action-branch-node-logs.test.ts`**

Run: `cd flow && npx vitest run tests/unit/content-action-branch-node-logs.test.ts`
Expected: all passed

- [ ] **Step 10: Fix `queue-content.test.ts`**

In `flow/tests/unit/queue-content.test.ts`, apply the same inert `"noopLeaf"` swap from Steps 6/8 — no fetch stubbing needed anywhere in this file as a result.

The first fixture (`graphContentToStatus`, lines 6-12): change line 9 from:
```ts
    { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
```
to:
```ts
    { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
```
Delete the now-inaccurate trailing comment on lines 99-102 (`// no-op: violates tenants.email NOT NULL — intentionally left / unresolvable so the updateContentStatus action's SELECT ... WHERE tenant_id = ? finds no / row and skips constructing a real TenantDataDB...`) — the `INSERT INTO tenants` line above it (line 97-99) and the `tenants` table creation (lines 84-91) are no longer load-bearing for this describe block (`noopLeaf` never queries `WEB_DB`), but leave them in place to minimize unrelated diff noise (they're harmless no-ops either way).

The second fixture (`graphWithBranchesObj`, lines 137-150, downstream of a1's real `xContentAction` branch — same reasoning as Step 8): change lines 141-142 from:
```ts
      { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 100 } },
```
to:
```ts
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
```
Update the test title on line 171 (`"resolves the success branch and runs updateContentStatus(published) when link returns ok:true"`) to `"resolves the success branch and runs a2 when link returns ok:true"`, and delete its body comment on lines 179-182 referencing "updateContentStatus tries to look up the tenant's d1_database_id and no-ops if missing" (no longer accurate — `noopLeaf` isn't recognized by any execution branch at all, so nothing is queried).

- [ ] **Step 11: Run `queue-content.test.ts`**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: all passed

- [ ] **Step 12: Fix `scheduled-content.test.ts`**

In `flow/tests/unit/scheduled-content.test.ts`, apply the same `"noopLeaf"` swap: change the `graphWithWait` fixture's `a1` node (line 9) from `{ id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },` to `{ id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },`, and delete the now-inaccurate comment on lines 85-88 (`// updateContentStatus (the action in graphWithWait) looks up tenants.d1_database_id...`) along with the `tenants` table creation block it justified (lines 89-96) if nothing else in the file depends on `WEB_DB` — run `grep -n "WEB_DB" flow/tests/unit/scheduled-content.test.ts` after the edit to confirm before deleting; the file's second describe block (around line 141-142, the branch-testing one with `updateContentStatus` fixtures at those lines and an existing `fetch` stub at line 189) needs the identical `updateContentStatus` → `noopLeaf` swap applied to its `a2`/`a3` nodes, following the same pattern as Step 8 (these are also downstream leaves of a real branching action).

- [ ] **Step 13: Run `scheduled-content.test.ts`**

Run: `cd flow && npx vitest run tests/unit/scheduled-content.test.ts`
Expected: all passed

- [ ] **Step 14: Fix `emit-content-node-logs.test.ts`**

In `flow/tests/unit/emit-content-node-logs.test.ts`, change line 8 from `{ id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },` to `{ id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },`, and delete the now-inaccurate comment on lines 45-50 (`// updateContentStatus (in the test graph below) queries env.WEB_DB.tenants...`) along with the `tenants` table creation block it justified, following the same "confirm no other `WEB_DB` reference remains before deleting" check as Step 12. No fetch stub is needed — `noopLeaf` has no execution side effects.

- [ ] **Step 15: Run `emit-content-node-logs.test.ts`**

Run: `cd flow && npx vitest run tests/unit/emit-content-node-logs.test.ts`
Expected: all passed

- [ ] **Step 16: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: all passed — this is the first point every `updateContentStatus` reference in the codebase has been either removed or replaced, so this run is the final check for anything missed.

Run: `grep -rn "updateContentStatus" flow/ link/ --include="*.ts" --include="*.tsx"`
Expected: no output (zero remaining references)

- [ ] **Step 17: Commit**

```bash
git add flow/frontend/ flow/tests/unit/engine.test.ts flow/tests/unit/content-action-branch-node-logs.test.ts flow/tests/unit/queue-content.test.ts flow/tests/unit/scheduled-content.test.ts flow/tests/unit/emit-content-node-logs.test.ts
git commit -m "feat(flow): remove updateContentStatus from frontend; migrate its test fixtures to xContentAction"
```

---

## Manual dev verification (after all tasks)

1. `wrangler dev` (or deploy to dev) for `admin`, `link`, `flow`.
2. Trigger `admin`'s tenant-provisioning path (or directly run `operation/migrate-tenant-dbs.ts dev`) and confirm `content_trigger_dedup` exists in a dev tenant DB: `wrangler d1 execute <tenant-db-name> --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='content_trigger_dedup'"`.
3. In the flow editor, open a content-domain flow's Sidebar and confirm "Update Content Status" no longer appears as a draggable action.
4. Trigger an X List Posts poll (or wait for the cron) against a real test list and confirm: (a) a new tweet fires the flow exactly once, (b) re-running the poller against the same tweet does not re-fire it, (c) `SELECT * FROM content WHERE channel_id = '<listChannelId>'` on the tenant DB shows no new row for that tweet, (d) `SELECT * FROM content_trigger_dedup` shows the new row.
