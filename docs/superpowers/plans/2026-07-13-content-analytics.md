# Content Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Content Analysis" report type (`type: "content"`) to the `analytics` module, querying the existing `uniscrm.content` R2 table with the exact same snapshot-aggregate shape User Analysis already uses against `uniscrm.user`, reusing code rather than duplicating it.

**Architecture:** Extract the current `type === "user"` SQL-building logic into a shared `buildSnapshotSQL(tableName, params, tenantId)` helper used by both `"user"` and a new `"content"` branch. On the frontend, widen the existing `mode === "user"` branches (config UI, chart rendering, default chart type) to also match `mode === "content"`, sourcing dimension/measure-field pickers from an entity-aware filter over the shared `PROPS_X` metadata registry instead of a hardcoded flat list.

**Tech Stack:** Cloudflare Workers (Hono), React + recharts, TypeScript, Vitest (`@cloudflare/vitest-pool-workers`, matching the `link`/`web` modules' existing setup).

## Global Constraints

- 少改动、稳定优先 (repo CLAUDE.md): reuse code paths, don't restructure files beyond what's needed.
- 前端不用 inline CSS，全部组件化 (repo CLAUDE.md): no new inline styles.
- 所有 icons 都要加 tooltip 文字 (repo CLAUDE.md): the content chart-type toggle reuses the existing `ChartTypeToggle` component, which already provides tooltips — no new icons introduced.
- 因为 R2 SQL 没有 API，只有 CLI，所以用 worker container 运行 (analytics/CLAUDE.md): unaffected — this plan only changes SQL string construction, not the container query path.
- Per root CLAUDE.md coding-agent workflow: after implementation, run dev server self-test and write/verify test cases in `tests/` before reporting done.

---

## File Structure

- **Modify** `metadata/dataTypes.ts` — add `entity?: Array<"user" | "content">` to `PropDefinition`.
- **Modify** `metadata/x.ts` — tag each `PROPS_X` entry that is a real column on the `user` or `content` R2 table with its `entity`.
- **Modify** `analytics/src/index.ts` — extract `buildSnapshotSQL`, add `"content"` branch to `buildSQL`.
- **Create** `analytics/vitest.config.ts`, **Modify** `analytics/package.json` — add test tooling (matching `link`/`web`).
- **Create** `analytics/tests/unit/sql-builder.test.ts` — unit tests for `buildSnapshotSQL`/`buildSQL`.
- **Create** `analytics/tests/unit/metadata-entity.test.ts` — unit tests for entity-tagged `PROPS_X`.
- **Modify** `analytics/frontend/components/ReportConfig.tsx` — entity-aware prop filtering, extend `"user"` branches to `"content"`.
- **Modify** `analytics/frontend/pages/AnalyticsList.tsx` — add "Content Analysis" to the `+New` dropdown.
- **Modify** `analytics/frontend/pages/AnalyticsDetail.tsx` — extend `mode` union and all `"user"`-gated branches to include `"content"`.
- **Modify** `analytics/frontend/App.tsx` — add `/analytics/content/new` route.

---

### Task 1: Tag PROPS_X entries with their owning entity (user/content)

**Files:**
- Modify: `metadata/dataTypes.ts`
- Modify: `metadata/x.ts`
- Test: `analytics/tests/unit/metadata-entity.test.ts` (new file; test tooling for the `analytics` module is set up in Task 2, but this test file can be written now and will start passing once Task 2's vitest config exists — write it now so Task 2's "run tests" step covers it too)

**Interfaces:**
- Produces: `PropDefinition.entity?: Array<"user" | "content">` — consumed by `ReportConfig.tsx` in Task 3 to filter dimension/measure-field pickers per report mode.

- [ ] **Step 1: Add the `entity` field to `PropDefinition`**

In `metadata/dataTypes.ts`, change:

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  isInsight?: boolean;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

to:

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  isInsight?: boolean;
  // Which R2 snapshot table(s) this prop is a real column on. Drives which
  // props Content/User Analysis dimension & measure-field pickers offer —
  // keep in sync with link/src/services/x-users.ts's USER_TABLE_COLUMNS and
  // link/src/services/content.ts's CONTENT_COLUMN_MAP.
  entity?: Array<"user" | "content">;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

- [ ] **Step 2: Tag every PROPS_X entry that is a real column on `user` or `content`**

Ground truth for column membership: `link/src/services/x-users.ts`'s `USER_TABLE_COLUMNS` (`name, username, profile_image_url, description, followers_count, following_count, tweet_count, listed_count, like_count, media_count, is_follow, is_followed`) and `link/src/services/content.ts`'s `CONTENT_COLUMN_MAP` keys (`content_type, content_text, title, source_created_at, bookmark_count, impression_count, like_count, quote_count, reply_count, repost_count`). `like_count` is a real column on both tables.

In `metadata/x.ts`, replace the `PROPS_X` array (currently lines 5–169) with:

```ts
export const PROPS_X = definePropDefinitions([
  {
    propId: "user_id", //用于content commerce等与USER表关联
    dataType: "TEXT",
    label: { en: "user id", zh: "user id" },
  },
  {
    propId: "source_user_id",
    dataType: "TEXT",
    label: { en: "source user id", zh: "源 user id" },
  },
  {
    propId: "name",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Name", zh: "名称" },
  },
  {
    propId: "username",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Username", zh: "用户名" },
  },
  {
    propId: "is_follow",
    isInsight: true,
    dataType: "ENUM_INT",
    entity: ["user"],
    label: { en: "Is following", zh: "是否关注" },
    enums: [
      { value: 0, label: { en: "Not following", zh: "未关注" } },
      { value: 1, label: { en: "Following", zh: "关注中" } },
    ],
  },
  {
    propId: "is_followed",
    isInsight: true,
    dataType: "ENUM_INT",
    entity: ["user"],
    label: { en: "Is followed", zh: "是否被关注" },
    enums: [
      { value: 0, label: { en: "Not followed", zh: "未被关注" } },
      { value: 1, label: { en: "Followed", zh: "被关注中" } },
    ],
  },
  {
    propId: "verified_type",
    isInsight: true,
    dataType: "ENUM_TEXT",
    label: { en: "Verification Type", zh: "认证类型" },
    enums: [
      { value: "blue", label: { en: "Blue Verified", zh: "蓝V" } },
      { value: "none", label: { en: "None", zh: "无" } },
    ],
  },
  {
    propId: "description",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Description", zh: "描述" },
  },
  {
    propId: "profile_image_url",
    dataType: "TEXT",
    entity: ["user"],
    label: { en: "Profile Image URL", zh: "头像URL" },
  },
  {
    propId: "followers_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Followers", zh: "粉丝数" },
  },
  {
    propId: "following_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Following", zh: "关注数" },
  },
  {
    propId: "tweet_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Tweets", zh: "发帖数" },
  },
  {
    propId: "listed_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Lists", zh: "收藏数" },
  },
  {
    propId: "like_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user", "content"],
    label: { en: "Likes", zh: "点赞数" },
  },
  {
    propId: "media_count",
    isInsight: true,
    dataType: "INT",
    entity: ["user"],
    label: { en: "Medias", zh: "多媒体数" },
  },
  {
    propId: "message_text",
    isInsight: true,
    dataType: "TEXT",
    label: { en: "Message text", zh: "消息文本" },
  },
  {
    propId: "source_created_at",
    isInsight: true,
    dataType: "DATETIME",
    entity: ["content"],
    label: { en: "Posted at", zh: "发布时间" },
  },
  {
    propId: "source_content_id",
    dataType: "TEXT",
    label: { en: "Source Content ID", zh: "源 Content ID" },
  },
  {
    propId: "content_type",
    isInsight: true,
    dataType: "ENUM_TEXT",
    entity: ["content"],
    label: { en: "Content Type", zh: "内容类型" },
    enums: [
      { value: "TWEET", label: { en: "Tweet", zh: "推文" } },
      { value: "ARTICLE", label: { en: "Article", zh: "文章" } },
    ],
  },
  {
    propId: "title",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Title", zh: "标题" },
  },
  {
    propId: "content_text",
    dataType: "TEXT",
    entity: ["content"],
    label: { en: "Content Text", zh: "内容文本" },
  },
  {
    propId: "bookmark_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Bookmarks", zh: "收藏数" },
  },
  {
    propId: "impression_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Impressions", zh: "曝光数" },
  },
  {
    propId: "quote_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Quotes", zh: "Quotes" },
  },
  {
    propId: "reply_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Replies", zh: "回复数" },
  },
  {
    propId: "repost_count",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Reposts", zh: "转发数" },
  },
]);
```

(`verified_type`, `message_text`, `user_id`, `source_user_id`, `source_content_id` are intentionally left untagged — they are event-level snapshot fields or raw IDs, not real columns on either the `user` or `content` R2 table, so they should not appear in either mode's dimension/measure-field picker. This also fixes a pre-existing bug where `verified_type` and `message_text` incorrectly showed up as selectable User Analysis dimensions today.)

- [ ] **Step 3: Write the entity-filtering test**

Create `analytics/tests/unit/metadata-entity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROPS_X } from "../../../metadata/x";

describe("PROPS_X entity tagging", () => {
  const insightProps = PROPS_X.filter((p) => p.isInsight);
  const userProps = insightProps.filter((p) => p.entity?.includes("user"));
  const contentProps = insightProps.filter((p) => p.entity?.includes("content"));

  it("keeps content-only fields out of the user-entity set", () => {
    const userPropIds = userProps.map((p) => p.propId);
    expect(userPropIds).not.toContain("content_type");
    expect(userPropIds).not.toContain("bookmark_count");
  });

  it("keeps user-only fields out of the content-entity set", () => {
    const contentPropIds = contentProps.map((p) => p.propId);
    expect(contentPropIds).not.toContain("is_follow");
    expect(contentPropIds).not.toContain("followers_count");
  });

  it("includes like_count in both entities since it is a real column on both tables", () => {
    const likeCount = insightProps.find((p) => p.propId === "like_count");
    expect(likeCount?.entity).toEqual(expect.arrayContaining(["user", "content"]));
  });

  it("excludes event-only fields (not real columns on either snapshot table) from both entities", () => {
    const verifiedType = insightProps.find((p) => p.propId === "verified_type");
    const messageText = insightProps.find((p) => p.propId === "message_text");
    expect(verifiedType?.entity ?? []).toHaveLength(0);
    expect(messageText?.entity ?? []).toHaveLength(0);
  });
});
```

This test can't run yet — `analytics` has no vitest setup. It will be executed for the first time at the end of Task 2, once the vitest config exists. Do not skip writing it now; just leave it uncommitted-but-unexecuted until Task 2, or commit it alongside this task's changes (either is fine, but Step 4 below only typechecks).

- [ ] **Step 4: Typecheck**

Run: `cd metadata/.. && cd analytics && npm run typecheck`
Expected: no errors (this catches any accidental duplicate-propId or malformed-object mistakes in the `PROPS_X` rewrite, via `definePropDefinitions`'s compile-time duplicate check).

Also run typecheck in `link` (the other consumer of `metadata/x.ts`):
Run: `cd link && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add metadata/dataTypes.ts metadata/x.ts analytics/tests/unit/metadata-entity.test.ts
git commit -m "Tag PROPS_X entries with owning entity (user/content)"
```

---

### Task 2: Extract buildSnapshotSQL and add the content branch to buildSQL

**Files:**
- Modify: `analytics/src/index.ts:493-533` (the `type === "user"` branch)
- Create: `analytics/vitest.config.ts`
- Modify: `analytics/package.json`
- Create: `analytics/tests/unit/sql-builder.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string` and `export function buildSQL(type: string, params: Record<string, unknown>, tenantId: string): string` (both now exported from `analytics/src/index.ts` for testability) — consumed only by this module's own `computeReport` and by the new test file.

- [ ] **Step 1: Add vitest tooling to the analytics module**

In `analytics/package.json`, change the `"scripts"` block from:

```json
  "scripts": {
    "dev": "vite",
    "dev:worker": "wrangler dev --env dev",
    "build": "vite build",
    "deploy:dev": "vite build --mode development && wrangler deploy --env dev",
    "deploy:prod": "vite build && wrangler deploy --env production",
    "typecheck": "tsc --noEmit"
  },
```

to:

```json
  "scripts": {
    "dev": "vite",
    "dev:worker": "wrangler dev --env dev",
    "build": "vite build",
    "deploy:dev": "vite build --mode development && wrangler deploy --env dev",
    "deploy:prod": "vite build && wrangler deploy --env production",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

and add to `"devDependencies"` (matching the versions already used in `link/package.json`):

```json
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "vitest": "^3.1.0",
```

Create `analytics/vitest.config.ts` (identical pattern to `link/vitest.config.ts`):

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml", environment: "dev" },
      },
    },
  },
});
```

Run: `cd analytics && npm install`
Expected: installs `vitest` and `@cloudflare/vitest-pool-workers` without errors.

- [ ] **Step 2: Write the failing tests**

Create `analytics/tests/unit/sql-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSQL, buildSnapshotSQL } from "../../src/index";

describe("buildSnapshotSQL", () => {
  it("builds a plain count query with no dimension", () => {
    const sql = buildSnapshotSQL("uniscrm.user", { measure: "count" }, "1");
    expect(sql).toContain("SELECT COUNT(*) as value");
    expect(sql).toContain("FROM uniscrm.user");
    expect(sql).toContain("WHERE tenant_id = 1");
    expect(sql).not.toContain("GROUP BY");
  });

  it("builds an avg query against a measure field", () => {
    const sql = buildSnapshotSQL("uniscrm.content", { measure: "avg", measure_field: "like_count" }, "1");
    expect(sql).toContain("AVG(CAST(like_count AS DOUBLE)) as value");
    expect(sql).toContain("FROM uniscrm.content");
  });

  it("builds a sum query against a measure field", () => {
    const sql = buildSnapshotSQL("uniscrm.content", { measure: "sum", measure_field: "bookmark_count" }, "1");
    expect(sql).toContain("SUM(CAST(bookmark_count AS DOUBLE)) as value");
  });

  it("groups by a plain dimension ordered by value desc", () => {
    const sql = buildSnapshotSQL("uniscrm.content", { measure: "count", dimension: "content_type" }, "1");
    expect(sql).toContain(", content_type as dimension");
    expect(sql).toContain("GROUP BY content_type ORDER BY value DESC");
  });

  it("groups by numeric buckets when provided", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "like_count", buckets: [100, 1000] },
      "1"
    );
    expect(sql).toContain("WHEN like_count < 100 THEN '0-100'");
    expect(sql).toContain("WHEN like_count < 1000 THEN '100-1000'");
    expect(sql).toContain("ELSE '1000+'");
    expect(sql).toContain("GROUP BY dimension ORDER BY dimension");
  });

  it("applies filter clauses", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", filters: [{ field: "content_type", operator: "=", value: "TWEET" }] },
      "1"
    );
    expect(sql).toContain("AND content_type = 'TWEET'");
  });
});

describe("buildSQL", () => {
  it("delegates the content type to uniscrm.content", () => {
    const sql = buildSQL("content", { measure: "count" }, "1");
    expect(sql).toContain("FROM uniscrm.content");
  });

  it("still delegates the user type to uniscrm.user (regression check)", () => {
    const sql = buildSQL("user", { measure: "count" }, "1");
    expect(sql).toContain("FROM uniscrm.user");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd analytics && npm test`
Expected: FAIL — `buildSQL`/`buildSnapshotSQL` are not exported from `src/index.ts` yet (import error), and the `metadata-entity.test.ts` file from Task 1 should now PASS (it doesn't depend on this task's changes).

- [ ] **Step 4: Extract buildSnapshotSQL and add the content branch**

In `analytics/src/index.ts`, change:

```ts
function buildSQL(type: string, params: Record<string, unknown>, tenantId: string): string {
```

to:

```ts
export function buildSQL(type: string, params: Record<string, unknown>, tenantId: string): string {
```

Then replace the `type === "user"` branch (currently):

```ts
  if (type === "user") {
    const { measure, measure_field, dimension, buckets, filters } = params as {
      measure: string; measure_field?: string; dimension?: string;
      buckets?: number[];
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    let dimExpr = "";
    let dimGroup = "";
    if (dimension) {
      if (buckets && buckets.length > 0) {
        const cases = buckets.map((b, i) => {
          const prev = i === 0 ? 0 : buckets[i - 1];
          return `WHEN ${dimension} < ${b} THEN '${prev}-${b}'`;
        });
        cases.push(`ELSE '${buckets[buckets.length - 1]}+'`);
        dimExpr = `, CASE ${cases.join(" ")} END as dimension`;
        dimGroup = " GROUP BY dimension ORDER BY dimension";
      } else {
        dimExpr = `, ${dimension} as dimension`;
        dimGroup = ` GROUP BY ${dimension} ORDER BY value DESC`;
      }
    }

    const agg = measure === "avg" && measure_field ? `AVG(CAST(${measure_field} AS DOUBLE))`
      : measure === "sum" && measure_field ? `SUM(CAST(${measure_field} AS DOUBLE))`
      : "COUNT(*)";

    return `SELECT ${agg} as value${dimExpr}
FROM uniscrm.user
WHERE tenant_id = ${tenantId} ${filterClauses}${dimGroup}`;
  }
```

with:

```ts
  if (type === "user") {
    return buildSnapshotSQL("uniscrm.user", params, tenantId);
  }

  if (type === "content") {
    return buildSnapshotSQL("uniscrm.content", params, tenantId);
  }
```

Then add the extracted helper as its own top-level function, right after `buildSQL`'s closing brace (i.e. immediately before the `if (type === "funnel")` block that used to follow the `user` branch — place `buildSnapshotSQL` after the entire `buildSQL` function ends, not inside it):

```ts
export function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string {
  const { measure, measure_field, dimension, buckets, filters } = params as {
    measure: string; measure_field?: string; dimension?: string;
    buckets?: number[];
    filters?: { field: string; operator: string; value: string; value2?: string }[];
  };

  const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
    if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
    if (f.operator === "no value") return `AND ${f.field} IS NULL`;
    if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
    const op = f.operator === "≠" ? "!=" : f.operator;
    const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
    return `AND ${f.field} ${op} ${val}`;
  }).join(" ");

  let dimExpr = "";
  let dimGroup = "";
  if (dimension) {
    if (buckets && buckets.length > 0) {
      const cases = buckets.map((b, i) => {
        const prev = i === 0 ? 0 : buckets[i - 1];
        return `WHEN ${dimension} < ${b} THEN '${prev}-${b}'`;
      });
      cases.push(`ELSE '${buckets[buckets.length - 1]}+'`);
      dimExpr = `, CASE ${cases.join(" ")} END as dimension`;
      dimGroup = " GROUP BY dimension ORDER BY dimension";
    } else {
      dimExpr = `, ${dimension} as dimension`;
      dimGroup = ` GROUP BY ${dimension} ORDER BY value DESC`;
    }
  }

  const agg = measure === "avg" && measure_field ? `AVG(CAST(${measure_field} AS DOUBLE))`
    : measure === "sum" && measure_field ? `SUM(CAST(${measure_field} AS DOUBLE))`
    : "COUNT(*)";

  return `SELECT ${agg} as value${dimExpr}
FROM ${tableName}
WHERE tenant_id = ${tenantId} ${filterClauses}${dimGroup}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd analytics && npm test`
Expected: PASS — all `sql-builder.test.ts` and `metadata-entity.test.ts` cases green.

- [ ] **Step 6: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add analytics/package.json analytics/vitest.config.ts analytics/tests/unit/sql-builder.test.ts analytics/src/index.ts
git commit -m "Extract buildSnapshotSQL helper; add content report type to buildSQL"
```

---

### Task 3: ReportConfig.tsx — entity-aware prop filtering + content mode

**Files:**
- Modify: `analytics/frontend/components/ReportConfig.tsx`

**Interfaces:**
- Consumes: `PropDefinition.entity` from Task 1.
- Produces: `ReportConfigValues.mode` and `ReportConfigProps.mode` now include `"content"` — consumed by `AnalyticsDetail.tsx` in Task 4.

- [ ] **Step 1: Replace the flat USER_PROPS constants with an entity-aware filter**

Change:

```ts
const TRIGGER_EVENTS = EventMetadata_X.filter((e) => e.flowType !== "action");
const USER_PROPS = PROPS_X.filter((p) => p.isInsight);
const NUMERIC_USER_PROPS = USER_PROPS.filter((p) => p.dataType === "INT");
```

to:

```ts
const TRIGGER_EVENTS = EventMetadata_X.filter((e) => e.flowType !== "action");
const propsByEntity = (entity: "user" | "content") =>
  PROPS_X.filter((p) => p.isInsight && p.entity?.includes(entity));
```

- [ ] **Step 2: Widen the `mode` type unions**

Change (two occurrences, `ReportConfigValues.mode` and `ReportConfigProps.mode`):

```ts
  mode?: "event" | "interval" | "user" | "funnel";
```

to (in both places):

```ts
  mode?: "event" | "interval" | "user" | "content" | "funnel";
```

- [ ] **Step 3: Compute entity-scoped prop lists inside the component**

Change:

```ts
export function ReportConfig({ values, onChange, mode: modeProp }: ReportConfigProps) {
  const { locale } = useLocale();
  const s = UI[locale];
  const mode = modeProp || values.mode || "event";
```

to:

```ts
export function ReportConfig({ values, onChange, mode: modeProp }: ReportConfigProps) {
  const { locale } = useLocale();
  const s = UI[locale];
  const mode = modeProp || values.mode || "event";
  const entityProps = propsByEntity(mode === "content" ? "content" : "user");
  const numericEntityProps = entityProps.filter((p) => p.dataType === "INT");
```

- [ ] **Step 4: Extend the measure block condition and its prop-list references**

Change:

```ts
            ) : mode === "user" ? (
              <>
                <Label className="mb-2 block">{s.measure}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any, measureField: e.target.value !== "count" ? (values.measureField || NUMERIC_USER_PROPS[0]?.propId || "") : undefined })}>
                    <option value="count">{locale === "zh" ? "用户数" : "User count"}</option>
                    <option value="avg">{locale === "zh" ? "平均值" : "Average"}</option>
                    <option value="sum">{locale === "zh" ? "总和" : "Sum"}</option>
                  </Select>
                  {(values.measure === "avg" || values.measure === "sum") && (
                    <>
                      <span className="text-muted-foreground text-sm">→</span>
                      <Select value={values.measureField || ""} onChange={(e) => update({ measureField: e.target.value })}>
                        {NUMERIC_USER_PROPS.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                      </Select>
                    </>
                  )}
                </div>
              </>
            ) : (
```

to:

```ts
            ) : mode === "user" || mode === "content" ? (
              <>
                <Label className="mb-2 block">{s.measure}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={values.measure} onChange={(e) => update({ measure: e.target.value as any, measureField: e.target.value !== "count" ? (values.measureField || numericEntityProps[0]?.propId || "") : undefined })}>
                    <option value="count">{mode === "content" ? (locale === "zh" ? "内容数" : "Content count") : (locale === "zh" ? "用户数" : "User count")}</option>
                    <option value="avg">{locale === "zh" ? "平均值" : "Average"}</option>
                    <option value="sum">{locale === "zh" ? "总和" : "Sum"}</option>
                  </Select>
                  {(values.measure === "avg" || values.measure === "sum") && (
                    <>
                      <span className="text-muted-foreground text-sm">→</span>
                      <Select value={values.measureField || ""} onChange={(e) => update({ measureField: e.target.value })}>
                        {numericEntityProps.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                      </Select>
                    </>
                  )}
                </div>
              </>
            ) : (
```

- [ ] **Step 5: Extend the dimension picker condition and its prop-list references**

Change:

```ts
              {mode === "user" ? (
                <Select value={values.dimension} onChange={(e) => update({ dimension: e.target.value, buckets: "" })}>
                  <option value="">{s.noGroup}</option>
                  {USER_PROPS.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                </Select>
              ) : (
```

to:

```ts
              {mode === "user" || mode === "content" ? (
                <Select value={values.dimension} onChange={(e) => update({ dimension: e.target.value, buckets: "" })}>
                  <option value="">{s.noGroup}</option>
                  {entityProps.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                </Select>
              ) : (
```

- [ ] **Step 6: Fix the bucket-boundary INT check**

Change:

```ts
            {values.dimension && USER_PROPS.find(p => p.propId === values.dimension)?.dataType === "INT" && (
```

to:

```ts
            {values.dimension && entityProps.find(p => p.propId === values.dimension)?.dataType === "INT" && (
```

- [ ] **Step 7: Extend the "not user mode" time-range/granularity/compare guard**

Change:

```ts
        {/* Time range + Granularity + Compare (not for user mode) */}
        {mode !== "user" && <div className="flex items-center gap-3 mt-4 flex-wrap">
```

to:

```ts
        {/* Time range + Granularity + Compare (not for user/content snapshot modes) */}
        {mode !== "user" && mode !== "content" && <div className="flex items-center gap-3 mt-4 flex-wrap">
```

- [ ] **Step 8: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add analytics/frontend/components/ReportConfig.tsx
git commit -m "ReportConfig: entity-aware prop filtering, extend user-mode UI to content mode"
```

---

### Task 4: Wire the "content" mode through AnalyticsList, AnalyticsDetail, and routing

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsList.tsx`
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`
- Modify: `analytics/frontend/App.tsx`

**Interfaces:**
- Consumes: `ReportConfig` with `mode="content"` from Task 3; `buildSQL`'s `"content"` branch from Task 2 (via the existing `/reports` API, unchanged).

- [ ] **Step 1: Add "Content Analysis" to the list page's +New dropdown**

In `analytics/frontend/pages/AnalyticsList.tsx`, change the `UI` dict:

```ts
const UI = {
  en: { newBtn: "New", event: "Event Analysis", interval: "Interval Analysis", user: "User Analysis", funnel: "Funnel Analysis", name: "Name", type: "Type", status: "Status", created: "Created", empty: "No reports yet", createFirst: "Create your first analysis" },
  zh: { newBtn: "新建", event: "事件分析", interval: "间隔分析", user: "用户分析", funnel: "漏斗分析", name: "名称", type: "类型", status: "状态", created: "创建时间", empty: "暂无报表", createFirst: "创建你的第一个分析" },
};

const TYPE_LABELS = { en: { event: "Event", interval: "Interval", user: "User", funnel: "Funnel" }, zh: { event: "事件", interval: "间隔", user: "用户", funnel: "漏斗" } };
```

to:

```ts
const UI = {
  en: { newBtn: "New", event: "Event Analysis", interval: "Interval Analysis", user: "User Analysis", content: "Content Analysis", funnel: "Funnel Analysis", name: "Name", type: "Type", status: "Status", created: "Created", empty: "No reports yet", createFirst: "Create your first analysis" },
  zh: { newBtn: "新建", event: "事件分析", interval: "间隔分析", user: "用户分析", content: "内容分析", funnel: "漏斗分析", name: "名称", type: "类型", status: "状态", created: "创建时间", empty: "暂无报表", createFirst: "创建你的第一个分析" },
};

const TYPE_LABELS = { en: { event: "Event", interval: "Interval", user: "User", content: "Content", funnel: "Funnel" }, zh: { event: "事件", interval: "间隔", user: "用户", content: "内容", funnel: "漏斗" } };
```

Then change the dropdown menu:

```ts
            <DropdownMenuItem onClick={() => navigate("/analytics/user/new")}>
              {s.user}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/funnel/new")}>
              {s.funnel}
            </DropdownMenuItem>
```

to:

```ts
            <DropdownMenuItem onClick={() => navigate("/analytics/user/new")}>
              {s.user}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/content/new")}>
              {s.content}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/funnel/new")}>
              {s.funnel}
            </DropdownMenuItem>
```

- [ ] **Step 2: Add the `/analytics/content/new` route**

In `analytics/frontend/App.tsx`, change:

```tsx
            <Route path="/analytics/user/new" element={<AnalyticsDetail mode="user" />} />
            <Route path="/analytics/funnel/new" element={<AnalyticsDetail mode="funnel" />} />
```

to:

```tsx
            <Route path="/analytics/user/new" element={<AnalyticsDetail mode="user" />} />
            <Route path="/analytics/content/new" element={<AnalyticsDetail mode="content" />} />
            <Route path="/analytics/funnel/new" element={<AnalyticsDetail mode="funnel" />} />
```

- [ ] **Step 3: Widen AnalyticsDetail's mode-related types and titles**

In `analytics/frontend/pages/AnalyticsDetail.tsx`, change:

```ts
const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analysis", zh: "事件分析" },
  interval: { en: "Interval Analysis", zh: "间隔分析" },
  user: { en: "User Analysis", zh: "用户分析" },
  funnel: { en: "Funnel Analysis", zh: "漏斗分析" },
};
```

to:

```ts
const MODE_TITLES: Record<string, { en: string; zh: string }> = {
  event: { en: "Event Analysis", zh: "事件分析" },
  interval: { en: "Interval Analysis", zh: "间隔分析" },
  user: { en: "User Analysis", zh: "用户分析" },
  content: { en: "Content Analysis", zh: "内容分析" },
  funnel: { en: "Funnel Analysis", zh: "漏斗分析" },
};
```

Add a `totalContent` label to the `UI` dict — change:

```ts
    step1Users: "Step 1 Users",
    completionRate: "Completion Rate",
    funnel: "Funnel",
    event: "Event",
    users: "Users",
    conv: "Conv.",
    overall: "Overall",
    totalUsers: "Total Users",
  },
```

to:

```ts
    step1Users: "Step 1 Users",
    completionRate: "Completion Rate",
    funnel: "Funnel",
    event: "Event",
    users: "Users",
    conv: "Conv.",
    overall: "Overall",
    totalUsers: "Total Users",
    totalContent: "Total Content",
  },
```

and change:

```ts
    step1Users: "第1步用户数",
    completionRate: "最终转化率",
    funnel: "漏斗",
    event: "事件",
    users: "用户数",
    conv: "转化率",
    overall: "总转化",
    totalUsers: "用户总数",
  },
} as const;
```

to:

```ts
    step1Users: "第1步用户数",
    completionRate: "最终转化率",
    funnel: "漏斗",
    event: "事件",
    users: "用户数",
    conv: "转化率",
    overall: "总转化",
    totalUsers: "用户总数",
    totalContent: "内容总数",
  },
} as const;
```

Change the component's mode prop and state types (two occurrences):

```ts
export function AnalyticsDetail({ mode: modeProp }: { mode?: "event" | "interval" | "user" | "funnel" }) {
```

to:

```ts
export function AnalyticsDetail({ mode: modeProp }: { mode?: "event" | "interval" | "user" | "content" | "funnel" }) {
```

and:

```ts
  const [mode, setMode] = useState<"event" | "interval" | "user" | "funnel">(modeProp || "event");
```

to:

```ts
  const [mode, setMode] = useState<"event" | "interval" | "user" | "content" | "funnel">(modeProp || "event");
```

- [ ] **Step 4: Extend the default chart-type logic (both places it's computed)**

Change:

```ts
  const [chartType, setChartType] = useState<string>(() => {
    const m = modeProp || "event";
    return m === "user" ? "pie" : m === "interval" ? "boxplot" : "line";
  });
```

to:

```ts
  const [chartType, setChartType] = useState<string>(() => {
    const m = modeProp || "event";
    return m === "user" || m === "content" ? "pie" : m === "interval" ? "boxplot" : "line";
  });
```

Change:

```ts
      if (typeof p.chart_type === "string") {
        setChartType(p.chart_type);
      } else {
        setChartType(resolvedMode === "user" ? "pie" : resolvedMode === "interval" ? "boxplot" : "line");
      }
```

to:

```ts
      if (typeof p.chart_type === "string") {
        setChartType(p.chart_type);
      } else {
        setChartType(resolvedMode === "user" || resolvedMode === "content" ? "pie" : resolvedMode === "interval" ? "boxplot" : "line");
      }
```

- [ ] **Step 5: Extend buildReportParams to send content-mode params identically to user-mode**

Change:

```ts
    if (mode === "user") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        buckets: buckets?.length ? buckets : undefined,
        filters: config.filters,
        chart_type: chartType,
      };
    }
```

to:

```ts
    if (mode === "user" || mode === "content") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        buckets: buckets?.length ? buckets : undefined,
        filters: config.filters,
        chart_type: chartType,
      };
    }
```

- [ ] **Step 6: Extend the time-series-chart suppression guard and the pie/bar results guard**

Change:

```ts
        {/* Event results — time series chart */}
        {hasData && mode !== "user" && eventData.length > 0 && (
```

to:

```ts
        {/* Event results — time series chart */}
        {hasData && mode !== "user" && mode !== "content" && eventData.length > 0 && (
```

Change:

```ts
        {/* User results — Pie/Bar chart + table (no dimension selected collapses to a single "Total" slice, same code path) */}
        {hasData && mode === "user" && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? t.totalUsers : (config.measureField || t.value), value: results.data[0].value }]
              : [];
```

to:

```ts
        {/* User/Content results — Pie/Bar chart + table (no dimension selected collapses to a single "Total" slice, same code path) */}
        {hasData && (mode === "user" || mode === "content") && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const totalLabel = mode === "content" ? t.totalContent : t.totalUsers;
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? totalLabel : (config.measureField || t.value), value: results.data[0].value }]
              : [];
```

- [ ] **Step 7: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add analytics/frontend/pages/AnalyticsList.tsx analytics/frontend/pages/AnalyticsDetail.tsx analytics/frontend/App.tsx
git commit -m "Wire content report mode through list, detail, and routing"
```

---

### Task 5: End-to-end self-test in dev

**Files:** none (manual verification only, per this repo's coding-agent workflow requirement)

- [ ] **Step 1: Start the dev server**

Run: `cd analytics && npm run dev`
Expected: Vite dev server starts without errors.

- [ ] **Step 2: Run the full test suite once more from a clean state**

Run: `cd analytics && npm run typecheck && npm test`
Expected: typecheck clean; all unit tests (`sql-builder.test.ts`, `metadata-entity.test.ts`) pass.

- [ ] **Step 3: Verify in browser**

Open the analytics dev app, navigate to Analytics → `+ New` → confirm "Content Analysis" appears in the dropdown between "User Analysis" and "Funnel Analysis". Create a Content Analysis report with `measure = count`, `dimension = content_type`:
- Confirm the dimension dropdown offers only content fields (`content_type`, `title`... `repost_count`) and does **not** offer `is_follow`/`followers_count`/etc.
- Confirm the report computes and renders as a pie chart by default, matching User Analysis's rendering, with a legend/table breakdown by `content_type`.
- Switch to bar chart via the toggle; confirm it renders correctly.
- Navigate to an existing User Analysis report; confirm its dimension dropdown no longer offers `content_type`/`bookmark_count` (regression check for the metadata fix in Task 1).

- [ ] **Step 4: Report completion**

No commit needed for this task (verification only). If any issue is found during manual verification, fix it in the relevant task's files, re-run that task's `npm test`/`npm run typecheck`, and commit the fix before reporting the plan complete.

---

## Self-Review Notes

- **Spec coverage:** §1 metadata entity tagging → Task 1. §2 backend helper extraction + content branch → Task 2. §3 frontend reuse (ReportConfig, AnalyticsList, AnalyticsDetail/App) → Tasks 3–4. §4 (no new infra) → nothing to build, confirmed no task creates R2/pipeline resources. §5 testing → Tasks 1–2 unit tests + Task 5 manual verification.
- **Type consistency:** `mode` unions, `entityProps`/`numericEntityProps` names, and `buildSnapshotSQL`/`buildSQL` signatures are consistent across all tasks that reference them.
- **No placeholders:** every step shows the exact before/after code or exact shell command with expected output.
