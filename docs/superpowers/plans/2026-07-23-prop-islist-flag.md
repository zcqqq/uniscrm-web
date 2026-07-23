# PropDefinition `isList` Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `PropDefinition` opt out of appearing as a column in the User/Content list tables (via a new `isList?: boolean` field, default `true`), without affecting its use elsewhere (e.g. analytics dimensions).

**Architecture:** Add `isList?: boolean` to `PropDefinition` (`metadata/dataTypes.ts`). Enforce it at a single choke point — `buildEntityColumns()` in `shared/frontend/lib/metadata-columns.tsx` — which both `link/frontend/pages/Users.tsx` and `link/frontend/components/ContentTable.tsx` already call to turn `metadata/props.ts`'s `PROPS` array into `DataTable` columns. No changes needed to `Users.tsx`, `ContentTable.tsx`, or `DataTable.tsx` themselves.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), existing `PropDefinition`/`buildEntityColumns` metadata-driven column pattern.

## Global Constraints

- `isList` default is `true` when the field is omitted — every existing `PROPS` entry must keep working with zero edits to its shape.
- Only an explicit `false` hides a column: the filter predicate is `p.isList !== false`, not `p.isList === true`.
- `isList` is orthogonal to `isInsight`: the analytics `ReportConfig.tsx` dimension/measure picker and its test (`analytics/tests/unit/metadata-entity.test.ts`) filter on `isInsight` + `entity` and must NOT be modified to respect `isList`.
- Mark `isList: false` on exactly three propIds in `metadata/props.ts`: `user_id`, `source_user_id`, `source_content_id` (internal record-linkage fields, never end-user display). No other propIds change.

---

### Task 1: Add `isList` field to `PropDefinition` and enforce it in `buildEntityColumns`

**Files:**
- Modify: `metadata/dataTypes.ts:6-18` (the `PropDefinition` interface)
- Modify: `shared/frontend/lib/metadata-columns.tsx:19-20` (the `buildEntityColumns` filter)
- Test: `analytics/tests/unit/metadata-columns.test.ts`

**Interfaces:**
- Consumes: nothing new — `buildEntityColumns<T>(props: readonly PropDefinition[], entity: "user"|"content", locale: Locale, timezone: string): Column<T>[]` (existing signature, unchanged).
- Produces: `PropDefinition.isList?: boolean` — later tasks (Task 2) set this field to `false` on specific `PROPS` entries in `metadata/props.ts`.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the existing `describe("buildEntityColumns", ...)` block in `analytics/tests/unit/metadata-columns.test.ts` (add the import shown, keep all existing tests untouched):

```ts
import { describe, it, expect } from "vitest";
import { buildEntityColumns } from "../../../shared/frontend/lib/metadata-columns";
import { PROPS } from "../../../metadata/props";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import type { PropDefinition } from "../../../metadata/dataTypes";
```

```ts
  it("excludes a prop explicitly marked isList: false", () => {
    const props: PropDefinition[] = [
      { propId: "a", dataType: "TEXT", entity: ["user"], isList: false, label: { en: "A", zh: "A" } },
      { propId: "b", dataType: "TEXT", entity: ["user"], label: { en: "B", zh: "B" } },
    ];
    const cols = buildEntityColumns<Row>(props, "user", "en", "UTC");
    const keys = cols.map((c) => c.key);
    expect(keys).not.toContain("a");
    expect(keys).toContain("b");
  });

  it("includes a prop when isList is omitted or explicitly true (default-true behavior)", () => {
    const props: PropDefinition[] = [
      { propId: "c", dataType: "TEXT", entity: ["user"], label: { en: "C", zh: "C" } },
      { propId: "d", dataType: "TEXT", entity: ["user"], isList: true, label: { en: "D", zh: "D" } },
    ];
    const cols = buildEntityColumns<Row>(props, "user", "en", "UTC");
    const keys = cols.map((c) => c.key);
    expect(keys).toContain("c");
    expect(keys).toContain("d");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `analytics/`): `npm test -- tests/unit/metadata-columns.test.ts`
Expected: the two new tests FAIL with a TypeScript error (`isList` does not exist on type `PropDefinition`) or, if TS is lenient at test-run time, a runtime assertion failure showing `keys` contains `"a"` (the filter isn't applied yet).

- [ ] **Step 3: Add `isList` to `PropDefinition`**

In `metadata/dataTypes.ts`, change:

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  fieldType?: PropFieldType;
  isInsight?: boolean;
  // Which R2 snapshot table(s) this prop is a real column on. Drives which
  // props Content/User Analytics dimension & measure-field pickers offer —
  // keep in sync with link/src/services/x-users.ts's USER_TABLE_COLUMNS and
  // link/src/services/content.ts's CONTENT_COLUMN_MAP.
  entity?: Array<"user" | "content">;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

to:

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  fieldType?: PropFieldType;
  isInsight?: boolean;
  // Default true when omitted. Set to false to hide this prop's column from
  // the User/Content list tables (buildEntityColumns in metadata-columns.tsx).
  // Orthogonal to isInsight — does not affect the analytics dimension/measure
  // picker (ReportConfig.tsx), which filters on isInsight + entity only.
  isList?: boolean;
  // Which R2 snapshot table(s) this prop is a real column on. Drives which
  // props Content/User Analytics dimension & measure-field pickers offer —
  // keep in sync with link/src/services/x-users.ts's USER_TABLE_COLUMNS and
  // link/src/services/content.ts's CONTENT_COLUMN_MAP.
  entity?: Array<"user" | "content">;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

- [ ] **Step 4: Enforce the filter in `buildEntityColumns`**

In `shared/frontend/lib/metadata-columns.tsx`, change:

```ts
  return props
    .filter((p) => p.entity?.includes(entity))
    .map((p) => {
```

to:

```ts
  return props
    .filter((p) => p.entity?.includes(entity) && p.isList !== false)
    .map((p) => {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `analytics/`): `npm test -- tests/unit/metadata-columns.test.ts`
Expected: all tests in the file PASS, including the two new ones.

- [ ] **Step 6: Run the full analytics test suite to confirm no regressions**

Run (from `analytics/`): `npm test`
Expected: all tests PASS (this file is shared code exercised via the `analytics` module's Vitest config; confirms `metadata-entity.test.ts`, which independently reimplements an `isInsight`-based filter, is unaffected).

- [ ] **Step 7: Commit**

```bash
git add metadata/dataTypes.ts shared/frontend/lib/metadata-columns.tsx analytics/tests/unit/metadata-columns.test.ts
git commit -m "feat: add isList flag to PropDefinition, enforce in buildEntityColumns"
```

---

### Task 2: Mark internal-linkage props with `isList: false`

**Files:**
- Modify: `metadata/props.ts` (the `user_id`, `source_user_id`, `source_content_id` entries)
- Test: `analytics/tests/unit/metadata-columns.test.ts`

**Interfaces:**
- Consumes: `PropDefinition.isList` (produced by Task 1).
- Produces: nothing new for later tasks — this is the final task in the plan.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe("buildEntityColumns", ...)` block in `analytics/tests/unit/metadata-columns.test.ts` (after the two tests added in Task 1):

```ts
  it("marks the internal record-linkage props isList: false in the real PROPS registry", () => {
    const userIdProp = PROPS.find((p) => p.propId === "user_id")!;
    const sourceUserIdProp = PROPS.find((p) => p.propId === "source_user_id")!;
    const sourceContentIdProp = PROPS.find((p) => p.propId === "source_content_id")!;
    expect(userIdProp.isList).toBe(false);
    expect(sourceUserIdProp.isList).toBe(false);
    expect(sourceContentIdProp.isList).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `analytics/`): `npm test -- tests/unit/metadata-columns.test.ts`
Expected: FAIL — `expect(userIdProp.isList).toBe(false)` fails because `isList` is currently `undefined` on all three props.

- [ ] **Step 3: Set `isList: false` on the three props**

In `metadata/props.ts`, change the `user_id` entry from:

```ts
  {
    propId: "user_id", //用于content commerce等与USER表关联
    dataType: "TEXT",
    label: { en: "user id", zh: "user id" },
  },
```

to:

```ts
  {
    propId: "user_id", //用于content commerce等与USER表关联
    dataType: "TEXT",
    isList: false,
    label: { en: "user id", zh: "user id" },
  },
```

Change the `source_user_id` entry from:

```ts
  {
    propId: "source_user_id",
    dataType: "TEXT",
    label: { en: "source user id", zh: "源 user id" },
  },
```

to:

```ts
  {
    propId: "source_user_id",
    dataType: "TEXT",
    isList: false,
    label: { en: "source user id", zh: "源 user id" },
  },
```

Change the `source_content_id` entry from:

```ts
  {
    propId: "source_content_id",
    dataType: "TEXT",
    label: { en: "Source Content ID", zh: "源 Content ID" },
  },
```

to:

```ts
  {
    propId: "source_content_id",
    dataType: "TEXT",
    isList: false,
    label: { en: "Source Content ID", zh: "源 Content ID" },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `analytics/`): `npm test -- tests/unit/metadata-columns.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full analytics test suite to confirm no regressions**

Run (from `analytics/`): `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Run the `link` module test suite to confirm no regressions**

`Users.tsx` and `ContentTable.tsx` live in `link/frontend/`; the three edited props currently have no `entity` field so this change has no visible effect on today's list tables, but run the module's suite as a sanity check.

Run (from `link/`): `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add metadata/props.ts analytics/tests/unit/metadata-columns.test.ts
git commit -m "feat: mark internal-linkage props (user_id, source_user_id, source_content_id) isList: false"
```
