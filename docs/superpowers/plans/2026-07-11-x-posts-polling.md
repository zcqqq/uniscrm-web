# X BYOK Posts Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll X BYOK channels' own tweets (`get-posts`) hourly, backfilling on authorization and writing to the tenant `content` table, mirroring the existing `x-followers` poller.

**Architecture:** A new `x-posts` poller reuses the followers poller's two-phase (backfill/incremental) shape, the same `channel_poll_state` table (new `poller_name = 'posts'` row), and the same `handlePolling` cron loop — `cron.ts` gains a second direct call (`runPostsPoller`) alongside `runFollowersPoller`, not a separate registry abstraction (none exists today). Content writes go through a new `ContentService.upsertContentFromMetadata` method, parallel to the existing `syncBatch`.

**Tech Stack:** Cloudflare Workers, D1 (`LINK_DB` for `channel_poll_state`, per-tenant `TenantDataDB` for `content`), Vectorize (content embeddings), Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Scoped to BYOK X channels only (`config.is_byok === true`), never the system-default app — matches the existing followers poller's gating.
- `exclude=replies,retweets`, `tweet.fields=<all documented>`, no `expansions` param (decided: `includes` data is discarded, not merged into `raw_data`).
- `raw_data` = `JSON.stringify(rawItem)`, the whole `data[]` entry unfiltered — no per-field curation.
- A resolved prop with no D1 column mapping stays `raw_data`-only, never defaulted; unresolved column-mapped fields are omitted from the SQL, never written as `NULL`.
- No content pipeline/R2 stream exists and none is added by this feature — only D1 + Vectorize embedding.
- The 100-item `content` cap (`LimitService`) is removed entirely for `content` (not `products`).
- `content`/`user` tables live in **per-tenant** D1 databases (via `admin/src/services/tenant-init-sql.ts`, no migration runner) — schema changes there are one-off `wrangler d1 execute` scripts, never `link/migrations/*.sql` (that directory only applies to `LINK_DB`).
- Take a `wrangler d1 export` backup of `content` immediately before running the rebuild script on `uniscrm-t1-dev` or the production `uniscrm-t1`.

---

## File Structure

- `metadata/dataTypes.ts` — no signature change; `PropMapping` already covers both user and content prop mappings.
- `metadata/index.ts` — fix broken re-exports (currently references nonexistent `UserPropMapping`/`EventPropMapping` types and a nonexistent `ContentMetadata_X` from `./x`).
- `metadata/x.ts` — add `content_type` and `contentText` prop definitions to `PROPS_X`.
- `metadata/x-byok.ts` — unchanged (`ContentMetadata_X` already correct).
- `link/src/services/pollers/resolve-props.ts` — renamed from `resolve-user-props.ts`; same logic, generic naming, fixed type import.
- `link/src/services/pollers/x-posts.ts` — new poller, mirrors `x-followers.ts`.
- `link/src/services/x-posts-api.ts` — new X API client, mirrors `x-followers-api.ts`.
- `link/src/services/content.ts` — add `upsertContentFromMetadata`, fix `buildEmbeddingText`.
- `link/src/types.ts` — extend `ChannelType` to include `"X"`; extend `ContentRow` with `channel_id`, `content_type`, `content_text`, `source_created_at`; `title`/`summary` become `string | null`.
- `link/src/cron.ts` — `handlePolling` gains a `runPostsPoller` call per BYOK channel.
- `link/src/oauth.ts` — BYOK callback seeds both `'followers'` and `'posts'` poll-state rows.
- `link/src/routes-contents.ts` + `link/src/services/limit.ts` — remove the `content` cap enforcement (leave `ProductLimitService` untouched).
- `admin/src/services/tenant-init-sql.ts` — update `content` `CREATE TABLE` to the new shape for future tenants.
- One-off rebuild script (documented inline in Task 3, run manually — not a repo file) applied to `uniscrm-t1-dev` then production `uniscrm-t1`.

---

### Task 1: Fix `resolve-user-props` type import, rename to `resolve-props`

Both `resolve-user-props.ts` and its test import a nonexistent `UserPropMapping` type from `metadata/dataTypes.ts` (only `PropMapping` is defined there). This resolver has no user-specific logic and will be reused for `contentProps` — rename it and fix the import first, before anything depends on the new name.

**Files:**
- Create: `link/src/services/pollers/resolve-props.ts`
- Create: `link/tests/services/resolve-props.test.ts`
- Modify: `link/src/services/pollers/x-followers.ts:5` (import path/name)
- Modify: `metadata/index.ts`
- Delete: `link/src/services/pollers/resolve-user-props.ts`
- Delete: `link/tests/services/resolve-user-props.test.ts`

**Interfaces:**
- Produces: `resolveProps(item: Record<string, unknown>, props: PropMapping[], linkPrefix?: string): Record<string, unknown>` — used by Task 6's poller and already used (renamed call) in `x-followers.ts`.

- [ ] **Step 1: Write the new test file (copy of the old one, renamed import/type)**

```ts
// link/tests/services/resolve-props.test.ts
import { describe, it, expect } from "vitest";
import { resolveProps } from "../../src/services/pollers/resolve-props";
import type { PropMapping } from "../../../metadata/dataTypes";

describe("resolveProps", () => {
  const props: PropMapping[] = [
    { propId: "source_user_id", dataId: "{linkPrefix}.id" },
    { propId: "name", dataId: "{linkPrefix}.name" },
    { propId: "is_followed", value: 1 },
  ];

  it("resolves dataId fields relative to the item", () => {
    const item = { id: "123", name: "Ada", username: "ada" };
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({ source_user_id: "123", name: "Ada", is_followed: 1 });
  });

  it("omits a prop when its dataId resolves to nothing, rather than defaulting", () => {
    const item = { id: "123" }; // no "name"
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({ source_user_id: "123", is_followed: 1 });
    expect(result).not.toHaveProperty("name");
  });

  it("uses static value mappings verbatim regardless of item contents", () => {
    const item = { id: "1", is_followed: 0 };
    const result = resolveProps(item, props, "data[]");
    expect(result.is_followed).toBe(1);
  });

  it("works without a linkPrefix (dataId used as-is)", () => {
    const item = { id: "9", name: "Bob" };
    const mapping: PropMapping[] = [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
    ];
    const result = resolveProps(item, mapping);
    expect(result).toEqual({ source_user_id: "9", name: "Bob" });
  });

  it("resolves contentProps-shaped mappings identically (no user-specific logic)", () => {
    const item = { id: "t1", text: "hello world", created_at: "2026-07-11T00:00:00.000Z" };
    const props: PropMapping[] = [
      { propId: "content_type", value: "TWEET" },
      { propId: "posted_at", dataId: "{linkPrefix}.created_at" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "contentText", dataId: "{linkPrefix}.text" },
    ];
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({
      content_type: "TWEET",
      posted_at: "2026-07-11T00:00:00.000Z",
      source_content_id: "t1",
      contentText: "hello world",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd link && npx vitest run tests/services/resolve-props.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/pollers/resolve-props'`

- [ ] **Step 3: Create the renamed implementation file**

```ts
// link/src/services/pollers/resolve-props.ts
import { navigatePath } from "../../webhook";
import type { PropMapping } from "../../../../metadata/dataTypes";

export function resolveProps(
  item: Record<string, unknown>,
  props: PropMapping[],
  linkPrefix?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mapping of props) {
    if (mapping.value !== undefined) {
      result[mapping.propId] = mapping.value;
      continue;
    }
    if (!mapping.dataId) continue;
    const relativePath = linkPrefix
      ? mapping.dataId.replace(`{linkPrefix}.`, "")
      : mapping.dataId;
    const resolved = navigatePath(item, relativePath);
    if (resolved !== null && resolved !== undefined) {
      result[mapping.propId] = resolved;
    }
  }
  return result;
}
```

- [ ] **Step 4: Delete the old file and its test**

```bash
git rm link/src/services/pollers/resolve-user-props.ts link/tests/services/resolve-user-props.test.ts
```

- [ ] **Step 5: Update `x-followers.ts`'s import**

In `link/src/services/pollers/x-followers.ts`, change:
```ts
import { resolveUserProps } from "./resolve-user-props";
```
to:
```ts
import { resolveProps } from "./resolve-props";
```
and change the one call site (inside `upsertPage`):
```ts
const props = resolveUserProps(item, FOLLOWERS_METADATA.userProps, FOLLOWERS_METADATA.linkPrefix);
```
to:
```ts
const props = resolveProps(item, FOLLOWERS_METADATA.userProps, FOLLOWERS_METADATA.linkPrefix);
```

- [ ] **Step 6: Fix `metadata/index.ts`'s broken re-exports**

Replace the full contents of `metadata/index.ts`:
```ts
export type { PropDataType, LocalizedString, PropDefinition, PropMapping, UserMetadata, ContentMetadata, EventMetadata } from "./dataTypes";
export type { Locale } from "./locale";
export { t } from "./locale";
export { PROPS_X, EventMetadata_X, XAA_SUBSCRIPTION_EVENTS } from "./x";
export { UserMetadata_X, ContentMetadata_X } from "./x-byok";
```

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `cd link && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no new type errors.

- [ ] **Step 8: Commit**

```bash
git add link/src/services/pollers/resolve-props.ts link/tests/services/resolve-props.test.ts \
        link/src/services/pollers/x-followers.ts metadata/index.ts
git rm link/src/services/pollers/resolve-user-props.ts link/tests/services/resolve-user-props.test.ts
git commit -m "refactor(link): rename resolveUserProps to resolveProps, fix broken metadata re-exports"
```

---

### Task 2: `PROPS_X` additions + `types.ts` schema types

**Files:**
- Modify: `metadata/x.ts`
- Modify: `link/src/types.ts`

**Interfaces:**
- Produces: `PROPS_X` gains `content_type` (TEXT) and `contentText` (TEXT) entries. `ContentRow` and `ChannelType` gain the fields Task 4/6 write to.

- [ ] **Step 1: Add the two new prop definitions to `PROPS_X`**

In `metadata/x.ts`, add after the existing `contentText` entry is where it already lives — actually `contentText` and `source_content_id` already exist in `PROPS_X` (lines 113-122); only `content_type` is missing. Add it right after `source_content_id`:

```ts
  {
    propId: "source_content_id",
    dataType: "TEXT",
    label: { en: "Source Content ID", zh: "源 Content ID" },
  },
  {
    propId: "content_type",
    dataType: "TEXT",
    label: { en: "Content Type", zh: "内容类型" },
  },
  {
    propId: "contentText",
    dataType: "TEXT",
    label: { en: "Content Text", zh: "内容文本" },
  },
```
(replacing the existing `source_content_id`/`contentText` pair with this three-entry block — `content_type` inserted between them).

- [ ] **Step 2: Update `ChannelType` and `ContentRow` in `link/src/types.ts`**

Change:
```ts
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK";
```
to:
```ts
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X";
```

Change the `ContentRow` interface:
```ts
export interface ContentRow {
  id: string;
  channel_id: string | null;
  channel_type: ChannelType;
  content_type: string | null;
  source_content_id: string;
  title: string | null;
  content_text: string | null;
  summary: string | null;
  status: ContentStatus;
  source_url: string | null;
  source_updated_at: string | null;
  source_created_at: string | null;
  raw_data: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors. (`ContentService.syncBatch`/`update` construct `ContentRow` object literals — since all new fields are optional-shaped as `| null` and TS structural typing requires them present, this step will surface any literal that's now missing a field; fix by adding `channel_id: null, content_type: null, content_text: null, source_created_at: null` to those literals in `link/src/services/content.ts`'s `syncBatch`/`update` — do this now if `tsc` reports it.)

- [ ] **Step 4: Commit**

```bash
git add metadata/x.ts link/src/types.ts link/src/services/content.ts
git commit -m "feat(link): add content_type/contentText props and extend ContentRow for posts polling"
```

---

### Task 3: Tenant DB schema — `content` table rebuild (dev + prod)

This is a table rebuild (SQLite can't `ALTER COLUMN` to drop `NOT NULL`), run manually against tenant DBs — not a `link/migrations/*.sql` file.

**Files:**
- Modify: `admin/src/services/tenant-init-sql.ts` (future tenants)
- No repo file for the rebuild script itself — run inline via `wrangler d1 execute --command` or a scratch `.sql` file passed to `--file` (not committed).

- [ ] **Step 1: Update `tenant-init-sql.ts`'s `content` table for future tenants**

In `admin/src/services/tenant-init-sql.ts`, replace the `content` block:
```ts
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    channel_type TEXT NOT NULL,
    content_type TEXT,
    source_content_id TEXT NOT NULL,
    title TEXT,
    content_text TEXT,
    summary TEXT,
    status TEXT DEFAULT 'new',
    source_url TEXT,
    source_updated_at TEXT,
    source_created_at TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_source ON content(channel_id, source_content_id)`,
```
(replacing the old `content` `CREATE TABLE` and its old `idx_content_channel_source` on `(channel_type, source_content_id)`).

- [ ] **Step 2: Commit the tenant-init-sql change**

```bash
git add admin/src/services/tenant-init-sql.ts
git commit -m "feat(admin): update content table schema for future tenants (posts polling)"
```

- [ ] **Step 3: Back up `content` on `uniscrm-t1-dev`**

Run: `wrangler d1 export uniscrm-t1-dev --remote --table content --output /tmp/content-backup-dev-$(date +%Y%m%d).sql`
Expected: export file written, non-empty.

- [ ] **Step 4: Run the rebuild against `uniscrm-t1-dev`**

Write a scratch file (not committed) `/tmp/content-rebuild.sql`:
```sql
ALTER TABLE content RENAME TO content_old;

CREATE TABLE content (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  channel_type TEXT NOT NULL,
  content_type TEXT,
  source_content_id TEXT NOT NULL,
  title TEXT,
  content_text TEXT,
  summary TEXT,
  status TEXT DEFAULT 'new',
  source_url TEXT,
  source_updated_at TEXT,
  source_created_at TEXT,
  raw_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO content (id, channel_type, source_content_id, title, summary, status, source_url, source_updated_at, raw_data, created_at, updated_at)
SELECT id, channel_type, source_content_id, title, summary, status, source_url, source_updated_at, raw_data, created_at, updated_at FROM content_old;

DROP TABLE content_old;

CREATE UNIQUE INDEX idx_content_channel_source ON content(channel_id, source_content_id);
CREATE INDEX idx_content_status ON content(status);
```

Run: `wrangler d1 execute uniscrm-t1-dev --remote --file /tmp/content-rebuild.sql`
Expected: success, no errors.

- [ ] **Step 5: Verify the rebuild on dev**

Run: `wrangler d1 execute uniscrm-t1-dev --remote --command "PRAGMA table_info(content);"`
Expected: columns include `channel_id`, `content_type`, `content_text`, `source_created_at`; `title` shows `"notnull": 0`.

Run: `wrangler d1 execute uniscrm-t1-dev --remote --command "SELECT COUNT(*) FROM content;"`
Expected: same row count as before the rebuild (compare against the Step 3 backup's row count).

- [ ] **Step 6: Repeat Steps 3-5 against production `uniscrm-t1`**

Same commands with `uniscrm-t1` in place of `uniscrm-t1-dev`. Only proceed after dev verification (Step 5) passes cleanly.

---

### Task 4: `ContentService.upsertContentFromMetadata` + embedding fix

**Files:**
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts` (new file — no prior test file exists for `ContentService`)

**Interfaces:**
- Consumes: `ContentRow` from Task 2, `PropMapping` from `metadata/dataTypes.ts`.
- Produces: `ContentService.upsertContentFromMetadata(rawItem: Record<string, unknown>, resolvedProps: Record<string, unknown>, channelId: string, channelType: ChannelType): Promise<boolean>` — used by Task 6's poller.

- [ ] **Step 1: Write the failing tests**

```ts
// link/tests/services/content.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService } from "../../src/services/content";

function createMockTenantDb() {
  return {
    query: vi.fn(),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

describe("ContentService.upsertContentFromMetadata", () => {
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let ai: ReturnType<typeof createMockAi>;
  let vectorize: ReturnType<typeof createMockVectorize>;
  let service: ContentService;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    ai = createMockAi();
    vectorize = createMockVectorize();
    service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);
  });

  it("inserts a new content row and returns true when none exists for channel+source_content_id", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "t1", text: "hello world" };
    const resolvedProps = { source_content_id: "t1", content_type: "TWEET", contentText: "hello world" };

    const isNew = await service.upsertContentFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["chan1", "t1", "X"])
    );
  });

  it("updates and returns false when a content row already exists", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid" }]);
    const resolvedProps = { source_content_id: "t1", contentText: "updated text" };

    const isNew = await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(isNew).toBe(false);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(channel_id, source_content_id) DO UPDATE SET"),
      expect.arrayContaining(["existing-uuid"])
    );
  });

  it("writes content_type/contentText/posted_at to their mapped columns (content_type, content_text, source_created_at)", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      contentText: "hello world",
      posted_at: "2026-07-11T00:00:00.000Z",
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql, params] = tenantDb.run.mock.calls[0];
    expect(sql).toContain("content_type");
    expect(sql).toContain("content_text");
    expect(sql).toContain("source_created_at");
    expect(params).toEqual(expect.arrayContaining(["TWEET", "hello world", "2026-07-11T00:00:00.000Z"]));
  });

  it("omits an unresolved column-mapped field from the SQL entirely, rather than writing null", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = { source_content_id: "t1" }; // no content_type/contentText/posted_at resolved

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql] = tenantDb.run.mock.calls[0];
    expect(sql).not.toContain("content_type");
    expect(sql).not.toContain("content_text");
    expect(sql).not.toContain("source_created_at");
  });

  it("stores the full rawItem in raw_data, unfiltered", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "t1", text: "hi", extra_field: "kept" };

    await service.upsertContentFromMetadata(rawItem, { source_content_id: "t1" }, "chan1", "X");

    const [, params] = tenantDb.run.mock.calls[0];
    const rawDataArg = params.find((p: unknown) => typeof p === "string" && p.includes('"extra_field"'));
    expect(rawDataArg).toBe(JSON.stringify(rawItem));
  });

  it("triggers Vectorize embedding on insert", async () => {
    tenantDb.query.mockResolvedValue([]);
    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", contentText: "hello" }, "chan1", "X");

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("ContentService.buildEmbeddingText fallback (via embedContents through upsertContentFromMetadata)", () => {
  it("falls back to content_text when title is null", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([]);
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await service.upsertContentFromMetadata(
      { id: "t1", text: "tweet body text" },
      { source_content_id: "t1", contentText: "tweet body text" },
      "chan1",
      "X"
    );

    // title is never set by upsertContentFromMetadata, so the embedded text must come from content_text
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), { text: ["tweet body text"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: FAIL — `service.upsertContentFromMetadata is not a function`

- [ ] **Step 3: Implement `upsertContentFromMetadata` and the column map**

In `link/src/services/content.ts`, add near the top (after the `EMBEDDING_MODEL` constant):

```ts
// propId -> content column, for fields where the names diverge (unlike the `user` table's
// 1:1 name match). A resolved prop not in this map only ever lives in raw_data.
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  contentText: "content_text",
  posted_at: "source_created_at",
};
```

Add the method to the `ContentService` class (after `syncBatch`):

```ts
  async upsertContentFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: ChannelType
  ): Promise<boolean> {
    const sourceContentId = String(resolvedProps.source_content_id ?? "");
    if (!sourceContentId) throw new Error("upsertContentFromMetadata: missing source_content_id");

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

    const insertCols = ["id", "channel_id", "channel_type", "source_content_id", "raw_data", ...dynamicCols, "created_at", "updated_at"];
    const insertPlaceholders = ["?", "?", "?", "?", "?", ...dynamicCols.map(() => "?"), "?", "?"];
    const insertParams = [id, channelId, channelType, sourceContentId, rawData, ...dynamicCols.map((c) => columnValues[c]), now, now];
    const updateSets = [
      "raw_data = json_patch(content.raw_data, excluded.raw_data)",
      "updated_at = excluded.updated_at",
      ...dynamicCols.map((c) => `${c} = excluded.${c}`),
    ];

    await this.tenantDb.run(
      `INSERT INTO content (${insertCols.join(", ")})
       VALUES (${insertPlaceholders.join(", ")})
       ON CONFLICT(channel_id, source_content_id) DO UPDATE SET
         ${updateSets.join(",\n         ")}`,
      insertParams
    );

    await this.embedContents([{
      id,
      channel_id: channelId,
      channel_type: channelType,
      content_type: (columnValues.content_type as string) ?? null,
      source_content_id: sourceContentId,
      title: null,
      content_text: (columnValues.content_text as string) ?? null,
      summary: null,
      status: "new",
      source_url: null,
      source_updated_at: null,
      source_created_at: (columnValues.source_created_at as string) ?? null,
      raw_data: rawData,
      created_at: now,
      updated_at: now,
    }]);

    return isNew;
  }
```

- [ ] **Step 4: Fix `buildEmbeddingText`**

In `link/src/services/content.ts`, change:
```ts
  private buildEmbeddingText(item: ContentRow): string {
    const parts = [item.title];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }
```
to:
```ts
  private buildEmbeddingText(item: ContentRow): string {
    const parts = [item.title || item.content_text || ""];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: all PASS

- [ ] **Step 6: Run full suite + typecheck**

Run: `cd link && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no new errors.

- [ ] **Step 7: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "feat(link): add ContentService.upsertContentFromMetadata, fix title-less embedding text"
```

---

### Task 5: X posts API client

**Files:**
- Create: `link/src/services/x-posts-api.ts`
- Test: `link/tests/services/x-posts-api.test.ts`

**Interfaces:**
- Produces: `fetchPostsPage(accessToken: string, xUserId: string, paginationToken?: string): Promise<XPostsFetchResult>` — used by Task 6's poller. `XPostsFetchResult = { page: { data: Record<string, unknown>[]; nextToken?: string }; rateLimited: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// link/tests/services/x-posts-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPostsPage } from "../../src/services/x-posts-api";

describe("fetchPostsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests exclude=replies,retweets and no expansions param", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await fetchPostsPage("tok", "u1");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/2/users/u1/tweets");
    expect(calledUrl.searchParams.get("exclude")).toBe("replies,retweets");
    expect(calledUrl.searchParams.has("expansions")).toBe(false);
    expect(calledUrl.searchParams.get("tweet.fields")).toContain("public_metrics");
  });

  it("passes pagination_token when provided", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await fetchPostsPage("tok", "u1", "cursor123");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("pagination_token")).toBe("cursor123");
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await fetchPostsPage("tok", "u1");

    expect(result.rateLimited).toBe(true);
    expect(result.page.data).toEqual([]);
  });

  it("throws on other non-ok statuses", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(fetchPostsPage("tok", "u1")).rejects.toThrow("X get-posts failed: 500");
  });

  it("parses data and next_token from a successful response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "t1", text: "hi" }], meta: { next_token: "p2" } }), { status: 200 })
    );

    const result = await fetchPostsPage("tok", "u1");

    expect(result.rateLimited).toBe(false);
    expect(result.page.data).toEqual([{ id: "t1", text: "hi" }]);
    expect(result.page.nextToken).toBe("p2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/x-posts-api'`

- [ ] **Step 3: Implement the client**

```ts
// link/src/services/x-posts-api.ts
// Full set of tweet.fields the get-posts endpoint supports — requested in full so
// raw_data (see ContentService.upsertContentFromMetadata) captures everything X returns.
// https://docs.x.com/x-api/users/get-posts
const TWEET_FIELDS = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "edit_controls",
  "edit_history_tweet_ids",
  "entities",
  "geo",
  "in_reply_to_user_id",
  "lang",
  "non_public_metrics",
  "note_tweet",
  "organic_metrics",
  "possibly_sensitive",
  "promoted_metrics",
  "public_metrics",
  "referenced_tweets",
  "reply_settings",
  "scopes",
  "source",
  "withheld",
].join(",");

export interface XPostsPage {
  data: Record<string, unknown>[];
  nextToken?: string;
}

export interface XPostsFetchResult {
  page: XPostsPage;
  rateLimited: boolean;
}

export async function fetchPostsPage(
  accessToken: string,
  xUserId: string,
  paginationToken?: string
): Promise<XPostsFetchResult> {
  const url = new URL(`https://api.x.com/2/users/${xUserId}/tweets`);
  url.searchParams.set("max_results", "100");
  url.searchParams.set("exclude", "replies,retweets");
  url.searchParams.set("tweet.fields", TWEET_FIELDS);
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    return { page: { data: [] }, rateLimited: true };
  }
  if (!res.ok) {
    throw new Error(`X get-posts failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: Record<string, unknown>[]; meta?: { next_token?: string } };
  return { page: { data: body.data || [], nextToken: body.meta?.next_token }, rateLimited: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add link/src/services/x-posts-api.ts link/tests/services/x-posts-api.test.ts
git commit -m "feat(link): add X get-posts API client (fetchPostsPage)"
```

---

### Task 6: Posts poller (`x-posts.ts`)

**Files:**
- Create: `link/src/services/pollers/x-posts.ts`
- Test: `link/tests/services/x-posts.test.ts`

**Interfaces:**
- Consumes: `fetchPostsPage` (Task 5), `resolveProps` (Task 1), `ContentService.upsertContentFromMetadata` (Task 4), `ContentMetadata_X` from `metadata/x-byok.ts`.
- Produces: `runPostsPoller(ctx: PostsPollerContext): Promise<void>` — used by Task 7's `cron.ts`. `PostsPollerContext = { channelId: string; xUserId: string; accessToken: string; linkDb: D1Database; tenantDb: TenantDataDB; tenantId: number; ai: Ai; vectorize: VectorizeIndex; deadline: number }`.

- [ ] **Step 1: Write the failing tests (mirrors `x-followers.test.ts`)**

```ts
// link/tests/services/x-posts.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPostsPoller } from "../../src/services/pollers/x-posts";

function createMockLinkDb(initialState: { cursor: string | null; backfill_complete: number; last_polled_at: string | null } | null) {
  const state = { ...initialState } as any;
  const first = vi.fn().mockImplementation(() => Promise.resolve(state ? { ...state } : null));
  const run = vi.fn().mockImplementation(() => Promise.resolve({ success: true }));
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _state: state, _run: run, _bind: bind };
}

function createMockTenantDb() {
  return {
    query: vi.fn().mockResolvedValue([]), // every tweet is "new" by default
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

describe("runPostsPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  function baseCtx(linkDb: any, tenantDb: any, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "world" }], meta: {} }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tenantDb.run).toHaveBeenCalledTimes(2); // one INSERT per tweet
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb, { deadline: Date.now() - 1 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("post-backfill: stops after a page with zero new tweets", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    tenantDb.query
      .mockResolvedValueOnce([]) // page 1, tweet "t1" is new
      .mockResolvedValueOnce([{ id: "existing" }]); // page 2, tweet "t2" already known

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "b" }], meta: { next_token: "p3" } }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/x-posts.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/pollers/x-posts'`

- [ ] **Step 3: Implement the poller**

```ts
// link/src/services/pollers/x-posts.ts
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import { ContentService } from "../content";
import { fetchPostsPage } from "../x-posts-api";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";

const POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "get-posts")!;

export interface PostsPollerContext {
  channelId: string;
  xUserId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runPostsPoller(ctx: PostsPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'posts'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "posts_poll_skipped_not_seeded", channel_id: ctx.channelId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId);
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "posts_poll_started", channel_id: ctx.channelId, phase, cursor: state.cursor }));

  if (!state.backfill_complete) {
    await runBackfill(ctx, contentService, state.cursor);
  } else {
    await runIncrementalPoll(ctx, contentService);
  }
}

async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  channelId: string
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "X");
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: PostsPollerContext,
  contentService: ContentService,
  startCursor: string | null
): Promise<void> {
  let cursor = startCursor || undefined;
  let pagesFetched = 0;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchPostsPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "posts_poll_rate_limited", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(contentService, page.data, ctx.channelId);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'"
        )
        .bind(ctx.channelId)
        .run();
      console.log(JSON.stringify({ event: "posts_poll_backfill_complete", channel_id: ctx.channelId, pagesFetched }));
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'")
      .bind(cursor, ctx.channelId)
      .run();
  }

  console.log(JSON.stringify({ event: "posts_poll_deadline_reached", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: PostsPollerContext, contentService: ContentService): Promise<void> {
  let cursor: string | undefined;
  let pagesFetched = 0;
  let totalNew = 0;
  let stopReason: "rate_limited" | "no_new_content" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchPostsPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) { stopReason = "rate_limited"; break; }

    pagesFetched++;
    const newCount = await upsertPage(contentService, page.data, ctx.channelId);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_content"; break; }
    if (!page.nextToken) { stopReason = "no_next_page"; break; }
    cursor = page.nextToken;
  }

  console.log(JSON.stringify({ event: "posts_poll_incremental_complete", channel_id: ctx.channelId, pagesFetched, totalNew, stopReason }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'posts'")
    .bind(ctx.channelId)
    .run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/x-posts.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full suite + typecheck**

Run: `cd link && npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add link/src/services/pollers/x-posts.ts link/tests/services/x-posts.test.ts
git commit -m "feat(link): add x-posts poller (backfill + incremental)"
```

---

### Task 7: Wire `runPostsPoller` into `handlePolling`

**Files:**
- Modify: `link/src/cron.ts`
- Modify: `link/tests/services/cron-polling.test.ts`
- Modify: `link/src/oauth.ts`

**Interfaces:**
- Consumes: `runPostsPoller` (Task 6), `ContentMetadata_X`/poll-state row `poller_name = 'posts'`.

- [ ] **Step 1: Update the existing cron-polling test to also assert the posts poller is called**

In `link/tests/services/cron-polling.test.ts`, add the mock alongside the existing `runFollowersPoller` mock:

```ts
const runPostsPollerMock = vi.fn().mockResolvedValue(undefined);
// ...
vi.mock("../../src/services/pollers/x-posts", () => ({
  runPostsPoller: (...args: unknown[]) => runPostsPollerMock(...args),
}));
```

Add `runPostsPollerMock.mockClear();` to the `beforeEach`. In the existing `it(...)` test, add after the existing `runFollowersPollerMock` assertions:

```ts
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock.mock.calls[0][0]).toMatchObject({
      channelId: "chan-byok-config",
      xUserId: "xuser-1",
    });
```

The mock `createMockLinkDb`'s `prepare` already has a generic `if (sql.includes("channel_poll_state"))` branch that returns the same `pollStateRow` for any `poller_name` — no change needed there since it doesn't filter on `poller_name`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd link && npx vitest run tests/services/cron-polling.test.ts`
Expected: FAIL — `runPostsPollerMock` not called (module doesn't exist yet in `cron.ts`'s imports, or call count is 0)

- [ ] **Step 3: Wire the poller into `handlePolling`**

In `link/src/cron.ts`, add the import:
```ts
import { runPostsPoller } from "./services/pollers/x-posts";
```

In `handlePolling`'s per-channel loop, after the existing `runFollowersPoller` call inside the `try` block, add:
```ts
      await runPostsPoller({
        channelId: row.id,
        xUserId: config.x_user_id,
        accessToken,
        linkDb: env.LINK_DB,
        tenantDb,
        tenantId: row.tenant_id,
        ai: env.AI,
        vectorize: env.VECTORIZE,
        deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
      });
```
(both pollers share the per-channel `try`/`catch` — a posts-poll failure is caught by the same `catch (e)` block that already logs `followers_poll_error`; leave that log event name as-is since it's a pre-existing per-channel error catch, not posts-specific — this matches the existing pattern where one `catch` covers the whole per-channel block.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd link && npx vitest run tests/services/cron-polling.test.ts`
Expected: PASS

- [ ] **Step 5: Extend `oauth.ts`'s BYOK poll-state seeding to include `'posts'`**

In `link/src/oauth.ts`, the existing block:
```ts
      // Seed (or reset, on re-authorization) followers poll state — full backfill runs again
      await c.env.LINK_DB
        .prepare(
          `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
           VALUES (?, 'followers', NULL, 0, NULL, datetime('now'))
           ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
        )
        .bind(byokChannelId)
        .run();
```
becomes:
```ts
      // Seed (or reset, on re-authorization) poll state for both pollers — full backfill runs again
      for (const pollerName of ["followers", "posts"]) {
        await c.env.LINK_DB
          .prepare(
            `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
             VALUES (?, ?, NULL, 0, NULL, datetime('now'))
             ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
          )
          .bind(byokChannelId, pollerName)
          .run();
      }
```

- [ ] **Step 6: Run full suite + typecheck**

Run: `cd link && npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add link/src/cron.ts link/tests/services/cron-polling.test.ts link/src/oauth.ts
git commit -m "feat(link): wire posts poller into cron and BYOK poll-state seeding"
```

---

### Task 8: Remove the `content` row-count cap

**Files:**
- Modify: `link/src/routes-contents.ts`
- Modify: `link/src/services/limit.ts`

**Interfaces:**
- Removes `LimitService` (the `content`-specific class); `ProductLimitService` is untouched.

- [ ] **Step 1: Remove `LimitService` usage from the sync route**

In `link/src/routes-contents.ts`, remove the import and the check block:
```ts
import { LimitService } from "./services/limit.ts"; // DELETE this import
```
Delete:
```ts
    const limitService = new LimitService(tenantDataDb, c.env.VECTORIZE);
    const check = await limitService.checkContentLimit(items.length);
    if (!check.allowed && !confirmed) {
      return c.json({ needsConfirmation: true, overflow: check.overflow, wouldDelete: check.wouldDelete });
    }
    if (!check.allowed && confirmed) {
      await limitService.enforceContentLimit(check.overflow);
    }
```
Also remove `confirmed` from the destructured request body (no longer read):
```ts
    const { channel_type, items, confirmed } = await c.req.json<{
```
becomes:
```ts
    const { channel_type, items } = await c.req.json<{
```
and drop `confirmed?: boolean;` from that type.

- [ ] **Step 2: Delete `LimitService` from `limit.ts`, keep `ProductLimitService`**

In `link/src/services/limit.ts`, delete the entire `LimitService` class (the `checkContentLimit`/`enforceContentLimit` methods and their surrounding class block), leaving `MAX_ITEMS` (still used by `ProductLimitService`) and `ProductLimitService` untouched.

- [ ] **Step 3: Search for any other `LimitService` usages**

Run: `cd link && grep -rn "LimitService" src/ tests/ --include="*.ts" | grep -v ProductLimitService`
Expected: no remaining references outside the two files just edited. If any test file references `LimitService`, remove/update that reference now.

- [ ] **Step 4: Run full suite + typecheck**

Run: `cd link && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no errors from the removed import/class.

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-contents.ts link/src/services/limit.ts
git commit -m "feat(link): remove content row-count cap (no confirmation path for cron writes)"
```

---

## Self-Review

**Spec coverage:**
- Request shape (`exclude`, `tweet.fields`, no `expansions`) — Task 5. ✓
- `content` table schema rebuild (channel_id, content_type, content_text, source_created_at, nullable title) — Task 3, `tenant-init-sql.ts` in Task 3 Step 1. ✓
- Column mapping (`CONTENT_COLUMN_MAP`) — Task 4. ✓
- `ContentService.upsertContentFromMetadata` incl. atomic upsert, embedding trigger — Task 4. ✓
- Poller backfill/incremental phases, cron wiring, oauth seeding — Tasks 6-7. ✓
- `buildEmbeddingText` fix — Task 4 Step 4. ✓
- `resolveUserProps`→`resolveProps` rename + broken type import fix — Task 1. ✓
- content-count limit removal — Task 8. ✓
- Testing section's four bullets — covered across Task 1 (resolveProps), Task 4 (ContentService), Task 6 (poller), Task 7 (handlePolling selection, reusing the existing `cron-polling.test.ts` pattern). ✓

**Placeholder scan:** no TBD/TODO, no "similar to Task N" without code, no unshown code steps.

**Type consistency:** `PostsPollerContext` (Task 6) matches the object literal built in `cron.ts` (Task 7) field-for-field (`channelId`, `xUserId`, `accessToken`, `linkDb`, `tenantDb`, `tenantId`, `ai`, `vectorize`, `deadline`). `ContentRow` (Task 2) matches the fields `upsertContentFromMetadata` (Task 4) passes to `embedContents`. `CONTENT_COLUMN_MAP`'s target column names (`content_type`, `content_text`, `source_created_at`) match the columns added in Task 3's rebuild SQL and `tenant-init-sql.ts`.
