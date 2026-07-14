# DATETIME Dimension Granularity Configure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give DATETIME-typed report dimensions a `⚙️配置` control (mirroring the existing INT dimension control) that lets the user truncate to 不汇总/小时/天/周/月/季度 instead of grouping by the raw, full-precision timestamp, with a data-driven initial suggestion.

**Architecture:** The existing `BucketModePopover` (INT-only) is renamed to `IntDimensionPopover` for clarity, and a new sibling `DatetimeDimensionPopover` is added — a plain 6-option radio popover, not the 3-mode/custom-boundary editor INT uses. It fetches the dimension's actual `{min, max}` via an injected `fetchRange` prop (kept out of `shared/frontend/` module-coupling by dependency injection) to suggest an initial granularity. On the backend, the existing `buildDimensionBucketing` is split into `buildIntDimensionBucketing` (unchanged logic, renamed) and a new `buildDatetimeDimensionBucketing` that emits `DATE_TRUNC(...)`; both call sites dispatch purely on which wire param the frontend sent (`dimension_date_granularity` vs `dimension_bucket_mode`/`buckets`) — no backend metadata lookup needed. A new synchronous `GET /api/dimension-range` endpoint (the first non-queued R2 SQL query path in this codebase) serves the min/max lookup.

**Tech Stack:** React (analytics/shared frontend), TypeScript, Hono backend (`analytics/src/index.ts`), Vitest (pure-function unit tests only — no frontend component or HTTP-handler test infra exists in this repo).

## Global Constraints

- The 6 granularity options are fixed and always shown: 不汇总(`none`)/小时(`hour`)/天(`day`)/周(`week`)/月(`month`)/季度(`quarter`). There is no 7th "auto/adaptive" mode — the data-driven suggestion only affects which radio is pre-checked the *first* time the popover opens for a dimension with no saved choice; once picked, it is a fixed, persisted choice like any other config field.
- "不汇总"(`none`) means grouping by the raw, untruncated datetime value — the same as today's only (pre-feature) behavior — not "collapse to a single total row."
- Suggestion thresholds (span = max − min): ≤2 days → `hour`; ≤60 days → `day`; ≤365 days → `week`; ≤2 years → `month`; >2 years → `quarter`; single point or missing min/max → `none`.
- The min/max range query ignores the report's current `filters` — it queries the full, tenant-scoped range of the field.
- `dimension_date_granularity` is **not** added to `COSMETIC_PARAM_FIELDS` in `analytics/src/index.ts` — changing it alters the actual SQL grouping and must trigger recomputation, exactly like `dimension_bucket_mode`/`buckets` already do today.
- `shared/frontend/components/` must not import any specific module's API client (e.g. `analytics/frontend/lib/api.ts`) — `DatetimeDimensionPopover` receives its range-fetching function as an injected `fetchRange` prop instead of importing one itself.
- `BucketModePopover` is renamed to `IntDimensionPopover` (file + export), with no backward-compatible alias kept.

---

### Task 1: Rename `BucketModePopover` → `IntDimensionPopover`

**Files:**
- Rename: `shared/frontend/components/BucketModePopover.tsx` → `shared/frontend/components/IntDimensionPopover.tsx`
- Modify: `analytics/frontend/components/ReportConfig.tsx`
- Modify: `analytics/tests/unit/data-table-sort.test.ts` (comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `IntDimensionPopover` (component, same props as the old `BucketModePopover`) and `BucketMode` (type, unchanged name — it describes the 3 INT bucket modes, not the component). Task 5 imports `IntDimensionPopover` alongside the new `DatetimeDimensionPopover` from Task 4.

- [ ] **Step 1: Rename the file and its exports**

```bash
git mv shared/frontend/components/BucketModePopover.tsx shared/frontend/components/IntDimensionPopover.tsx
```

Replace the full contents of `shared/frontend/components/IntDimensionPopover.tsx` with (identical to the original file except `BucketModePopoverProps` → `IntDimensionPopoverProps` and the exported function name):

```tsx
import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Locale } from "../../../metadata/locale";

export type BucketMode = "discrete" | "default" | "custom";

interface IntDimensionPopoverProps {
  mode: BucketMode;
  buckets: string; // comma-separated ascending boundary points, e.g. "100,1000"
  onChange: (next: { mode: BucketMode; buckets: string }) => void;
  locale?: Locale;
}

const UI = {
  en: {
    configure: "Configure",
    title: "Choose how to group",
    discrete: "Use discrete numbers (no interval)",
    default: "Default interval",
    custom: "Use custom interval",
    addInterval: "+ Add interval",
    confirm: "Confirm",
  },
  zh: {
    configure: "配置",
    title: "选择如何分组",
    discrete: "使用离散数字(没有区间)",
    default: "默认区间",
    custom: "使用自定义区间",
    addInterval: "+ 添加区间",
    confirm: "确定",
  },
};

function parseBoundaries(buckets: string): number[] {
  return buckets.split(",").map(Number).filter((n) => !isNaN(n));
}

export function IntDimensionPopover({ mode, buckets, onChange, locale = "en" }: IntDimensionPopoverProps) {
  const s = UI[locale];
  const [open, setOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<BucketMode>(mode);
  const [draftBoundaries, setDraftBoundaries] = useState<number[]>(parseBoundaries(buckets));

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftMode(mode);
      setDraftBoundaries(parseBoundaries(buckets));
    }
    setOpen(next);
  };

  const setBoundaryAt = (idx: number, value: string) => {
    const n = Number(value);
    const next = [...draftBoundaries];
    if (value === "" || isNaN(n)) {
      next.splice(idx, 1);
    } else {
      next[idx] = n;
    }
    setDraftBoundaries(next);
  };

  const addInterval = () => setDraftBoundaries([...draftBoundaries, draftBoundaries[draftBoundaries.length - 1] ?? 0]);
  const removeInterval = (idx: number) => setDraftBoundaries(draftBoundaries.filter((_, i) => i !== idx));

  const confirm = () => {
    const sorted = [...draftBoundaries].sort((a, b) => a - b);
    onChange({ mode: draftMode, buckets: draftMode === "custom" ? sorted.join(",") : "" });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs text-primary hover:underline ml-2">
          ⚙️ {s.configure}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">{s.title}</span>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "discrete"} onChange={() => setDraftMode("discrete")} />
            {s.discrete}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "default"} onChange={() => setDraftMode("default")} />
            {s.default}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={draftMode === "custom"} onChange={() => setDraftMode("custom")} />
            {s.custom}
          </label>
        </div>
        {draftMode === "custom" && (
          <div className="mt-3 space-y-2">
            {Array.from({ length: draftBoundaries.length + 1 }).map((_, rowIdx) => {
              const isFirst = rowIdx === 0;
              const isLast = rowIdx === draftBoundaries.length;
              const lowerLabel = isFirst ? "-∞" : String(draftBoundaries[rowIdx - 1]);
              return (
                <div key={rowIdx} className="flex items-center gap-1 text-xs">
                  <span className="text-muted-foreground w-10 shrink-0">区间{rowIdx + 1}:</span>
                  <span>[</span>
                  <span className="w-14 text-center">{lowerLabel}</span>
                  <span>,</span>
                  {isLast ? (
                    <span className="w-16 text-center">+∞</span>
                  ) : (
                    <Input
                      type="number"
                      value={draftBoundaries[rowIdx] ?? ""}
                      onChange={(e) => setBoundaryAt(rowIdx, e.target.value)}
                      className="h-6 w-16 text-xs"
                    />
                  )}
                  <span>)</span>
                  {!isFirst && !isLast && (
                    <button type="button" className="text-muted-foreground hover:text-destructive ml-1" onClick={() => removeInterval(rowIdx - 1)}>
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addInterval}>
              {s.addInterval}
            </Button>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={confirm}>{s.confirm}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Update `ReportConfig.tsx`'s import and usage**

Replace:

```tsx
import { BucketModePopover, type BucketMode } from "../../../shared/frontend/components/BucketModePopover";
```

with:

```tsx
import { IntDimensionPopover, type BucketMode } from "../../../shared/frontend/components/IntDimensionPopover";
```

Replace:

```tsx
              {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
                <BucketModePopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
```

with:

```tsx
              {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
                <IntDimensionPopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
```

- [ ] **Step 3: Update the stale comment in `data-table-sort.test.ts`**

Replace:

```ts
    // bucket modes (see BucketModePopover) — Number() on these strings is
```

with:

```ts
    // bucket modes (see IntDimensionPopover) — Number() on these strings is
```

- [ ] **Step 4: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing error baseline as prior work in this repo (~150-210 lines, all pre-existing "missing @types/react" errors) — no new errors, and no error referencing `BucketModePopover` (confirming nothing still points at the old name).

Run: `grep -rn "BucketModePopover" ../.. --include="*.ts" --include="*.tsx" | grep -v node_modules`
Expected: no output (no remaining references anywhere in the repo).

- [ ] **Step 5: Commit**

```bash
git add shared/frontend/components/IntDimensionPopover.tsx analytics/frontend/components/ReportConfig.tsx analytics/tests/unit/data-table-sort.test.ts
git commit -m "refactor: rename BucketModePopover to IntDimensionPopover"
```

(Note: `git mv` followed by editing the destination file, then `git add` on both the new path and the deleted old path — `git add` on the new file path alone is sufficient; git detects the rename automatically as long as the old file no longer exists, which `git mv` already ensures.)

---

### Task 2: Backend — split dimension bucketing into INT and DATETIME variants

**Files:**
- Modify: `analytics/src/index.ts`
- Test: `analytics/tests/unit/sql-builder.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildIntDimensionBucketing(params: { dimension: string; mode?: "discrete"|"default"|"custom"; buckets?: number[]; fromTable: string; tenantId: string; scopeFilter: string }): { dimExpr, dimGroupCol, boundsCte, fromExtra }` (renamed from `buildDimensionBucketing`, logic unchanged) and `buildDatetimeDimensionBucketing(params: { dimension: string; dateGranularity?: "none"|"hour"|"day"|"week"|"month"|"quarter"; fromTable: string; tenantId: string; scopeFilter: string }): { dimExpr, dimGroupCol, boundsCte, fromExtra }` (new). Both are private (unexported) helpers, called from `buildSnapshotSQL` and `buildSQL`'s `"event"` branch — both already exported and used by Task 3's tests and by the existing test suite. Task 6 (frontend) relies on the wire param name `dimension_date_granularity` this task introduces on the backend side.

- [ ] **Step 1: Write the failing tests**

Add to `analytics/tests/unit/sql-builder.test.ts`, right after the existing `describe("buildSnapshotSQL", ...)` block's closing `});` (before any other top-level `describe`):

```ts
describe("buildSnapshotSQL datetime dimension granularity", () => {
  it("groups by raw datetime value when granularity is unset (regression check)", () => {
    const sql = buildSnapshotSQL("uniscrm.content", { measure: "count", dimension: "source_created_at" }, "1");
    expect(sql).toContain(", source_created_at as dimension");
    expect(sql).toContain("GROUP BY source_created_at ORDER BY value DESC");
  });

  it("truncates to day when dimension_date_granularity is 'day'", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "source_created_at", dimension_date_granularity: "day" },
      "1"
    );
    expect(sql).toContain(", DATE_TRUNC('day', source_created_at) as dimension");
    expect(sql).toContain("GROUP BY dimension ORDER BY dimension");
  });

  it("truncates to quarter when dimension_date_granularity is 'quarter'", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "source_created_at", dimension_date_granularity: "quarter" },
      "1"
    );
    expect(sql).toContain(", DATE_TRUNC('quarter', source_created_at) as dimension");
  });

  it("treats 'none' the same as unset (raw grouping, no DATE_TRUNC)", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "source_created_at", dimension_date_granularity: "none" },
      "1"
    );
    expect(sql).toContain(", source_created_at as dimension");
    expect(sql).not.toContain("DATE_TRUNC");
  });

  it("dimension_date_granularity takes priority over dimension_bucket_mode when both are present", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "source_created_at", dimension_date_granularity: "month", dimension_bucket_mode: "default" },
      "1"
    );
    expect(sql).toContain(", DATE_TRUNC('month', source_created_at) as dimension");
    expect(sql).not.toContain("bounds");
  });
});

describe("buildSQL event dimension datetime granularity", () => {
  it("truncates the event dimension to week", () => {
    const sql = buildSQL(
      "event",
      { event_type: "post.create", measure: "count", dimension: "source_created_at", granularity: "day", dimension_date_granularity: "week" },
      "1"
    );
    expect(sql).toContain(", DATE_TRUNC('week', source_created_at) as dimension");
    expect(sql).toContain("GROUP BY period, dimension ORDER BY period");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: FAIL — `dimension_date_granularity` is not yet recognized by `buildSnapshotSQL`/`buildSQL`, so every new assertion checking for `DATE_TRUNC(...)` fails (the current code always falls through to raw/discrete grouping for an unrecognized param).

- [ ] **Step 3: Rename `buildDimensionBucketing` to `buildIntDimensionBucketing`**

Replace:

```ts
function buildDimensionBucketing(params: {
  dimension: string;
  mode?: "discrete" | "default" | "custom";
  buckets?: number[];
  fromTable: string;
  tenantId: string;
  scopeFilter: string;
}): { dimExpr: string; dimGroupCol: string; boundsCte: string; fromExtra: string } {
  const { dimension, mode, buckets, fromTable, tenantId, scopeFilter } = params;
```

with:

```ts
function buildIntDimensionBucketing(params: {
  dimension: string;
  mode?: "discrete" | "default" | "custom";
  buckets?: number[];
  fromTable: string;
  tenantId: string;
  scopeFilter: string;
}): { dimExpr: string; dimGroupCol: string; boundsCte: string; fromExtra: string } {
  const { dimension, mode, buckets, fromTable, tenantId, scopeFilter } = params;
```

(the function body below this line is unchanged — only the name and the opening two lines shown above change).

- [ ] **Step 4: Add `buildDatetimeDimensionBucketing` immediately after `buildIntDimensionBucketing`'s closing brace**

Insert this new function directly after `buildIntDimensionBucketing`'s closing `}` and before `export function buildSnapshotSQL`:

```ts
function buildDatetimeDimensionBucketing(params: {
  dimension: string;
  dateGranularity?: "none" | "hour" | "day" | "week" | "month" | "quarter";
  fromTable: string;
  tenantId: string;
  scopeFilter: string;
}): { dimExpr: string; dimGroupCol: string; boundsCte: string; fromExtra: string } {
  const { dimension, dateGranularity } = params;

  if (dateGranularity && dateGranularity !== "none") {
    return {
      dimExpr: `, DATE_TRUNC('${dateGranularity}', ${dimension}) as dimension`,
      dimGroupCol: "dimension",
      boundsCte: "",
      fromExtra: "",
    };
  }

  // "none" (or unset) groups by the raw, untruncated value — identical to
  // the pre-feature-only behavior and to INT's "discrete" mode.
  return {
    dimExpr: `, ${dimension} as dimension`,
    dimGroupCol: dimension,
    boundsCte: "",
    fromExtra: "",
  };
}
```

- [ ] **Step 5: Wire the dispatch into `buildSnapshotSQL`**

Replace:

```ts
export function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string {
  const { measure, measure_field, dimension, buckets, dimension_bucket_mode, filters } = params as {
    measure: string; measure_field?: string; dimension?: string;
    buckets?: number[]; dimension_bucket_mode?: "discrete" | "default" | "custom";
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
  let boundsCte = "";
  let fromExtra = "";
  if (dimension) {
    const bucketing = buildDimensionBucketing({
      dimension, mode: dimension_bucket_mode, buckets,
      fromTable: tableName, tenantId, scopeFilter: filterClauses,
    });
    dimExpr = bucketing.dimExpr;
    boundsCte = bucketing.boundsCte;
    fromExtra = bucketing.fromExtra;
    dimGroup = bucketing.dimGroupCol === dimension
      ? ` GROUP BY ${dimension} ORDER BY value DESC`
      : " GROUP BY dimension ORDER BY dimension";
  }
```

with:

```ts
export function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string {
  const { measure, measure_field, dimension, buckets, dimension_bucket_mode, dimension_date_granularity, filters } = params as {
    measure: string; measure_field?: string; dimension?: string;
    buckets?: number[]; dimension_bucket_mode?: "discrete" | "default" | "custom";
    dimension_date_granularity?: "none" | "hour" | "day" | "week" | "month" | "quarter";
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
  let boundsCte = "";
  let fromExtra = "";
  if (dimension) {
    const bucketing = dimension_date_granularity
      ? buildDatetimeDimensionBucketing({
          dimension, dateGranularity: dimension_date_granularity,
          fromTable: tableName, tenantId, scopeFilter: filterClauses,
        })
      : buildIntDimensionBucketing({
          dimension, mode: dimension_bucket_mode, buckets,
          fromTable: tableName, tenantId, scopeFilter: filterClauses,
        });
    dimExpr = bucketing.dimExpr;
    boundsCte = bucketing.boundsCte;
    fromExtra = bucketing.fromExtra;
    dimGroup = bucketing.dimGroupCol === dimension
      ? ` GROUP BY ${dimension} ORDER BY value DESC`
      : " GROUP BY dimension ORDER BY dimension";
  }
```

- [ ] **Step 6: Wire the dispatch into `buildSQL`'s `"event"` branch**

Replace:

```ts
    const { event_type, measure, dimension, granularity, dimension_bucket_mode, buckets, time_range_start, time_range_end, filters } = params as {
      event_type: string; measure: string; dimension?: string; granularity?: string;
      dimension_bucket_mode?: "discrete" | "default" | "custom"; buckets?: number[];
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };
```

with:

```ts
    const { event_type, measure, dimension, granularity, dimension_bucket_mode, buckets, dimension_date_granularity, time_range_start, time_range_end, filters } = params as {
      event_type: string; measure: string; dimension?: string; granularity?: string;
      dimension_bucket_mode?: "discrete" | "default" | "custom"; buckets?: number[];
      dimension_date_granularity?: "none" | "hour" | "day" | "week" | "month" | "quarter";
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };
```

Then replace:

```ts
    if (dimension) {
      const bucketing = buildDimensionBucketing({
        dimension, mode: dimension_bucket_mode, buckets,
        fromTable: "uniscrm.event", tenantId, scopeFilter: eventScopeFilter,
      });
      dimCol = bucketing.dimExpr;
      boundsCte = bucketing.boundsCte;
      fromExtra = bucketing.fromExtra;
      dimGroupCol = bucketing.dimGroupCol;
    }
```

with:

```ts
    if (dimension) {
      const bucketing = dimension_date_granularity
        ? buildDatetimeDimensionBucketing({
            dimension, dateGranularity: dimension_date_granularity,
            fromTable: "uniscrm.event", tenantId, scopeFilter: eventScopeFilter,
          })
        : buildIntDimensionBucketing({
            dimension, mode: dimension_bucket_mode, buckets,
            fromTable: "uniscrm.event", tenantId, scopeFilter: eventScopeFilter,
          });
      dimCol = bucketing.dimExpr;
      boundsCte = bucketing.boundsCte;
      fromExtra = bucketing.fromExtra;
      dimGroupCol = bucketing.dimGroupCol;
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: PASS — all new tests green, and every pre-existing test in this file (INT bucket modes, plain dimension, no-dimension cases) still passes unchanged, since `buildIntDimensionBucketing` is a pure rename with identical logic and is only reached when `dimension_date_granularity` is absent.

- [ ] **Step 8: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors.

- [ ] **Step 9: Commit**

```bash
git add analytics/src/index.ts analytics/tests/unit/sql-builder.test.ts
git commit -m "feat: add DATETIME dimension truncation (DATE_TRUNC) alongside INT bucketing"
```

---

### Task 3: Backend — `GET /api/dimension-range` endpoint

**Files:**
- Modify: `analytics/src/index.ts`
- Test: `analytics/tests/unit/sql-builder.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `buildDimensionRangeSQL(mode: string, dimension: string, tenantId: string): string` (exported, pure, unit-tested — mirrors how `buildSQL`/`buildSnapshotSQL` are the testable surface for SQL generation in this file). `GET /api/dimension-range?mode=user|content|event&dimension=<propId>` → `{ min: string | null; max: string | null }`, tenant-scoped via the existing `authMiddleware`. Task 4's `getDimensionRange` frontend API wrapper calls this endpoint.

- [ ] **Step 1: Write the failing test**

Add to `analytics/tests/unit/sql-builder.test.ts`, at the end of the file:

```ts
describe("buildDimensionRangeSQL", () => {
  it("maps mode to the correct table", () => {
    expect(buildDimensionRangeSQL("user", "followers_count", "1")).toContain("FROM uniscrm.user");
    expect(buildDimensionRangeSQL("content", "source_created_at", "1")).toContain("FROM uniscrm.content");
    expect(buildDimensionRangeSQL("event", "source_created_at", "1")).toContain("FROM uniscrm.event");
  });

  it("selects MIN/MAX aliased as mn/mx, scoped by tenant", () => {
    const sql = buildDimensionRangeSQL("content", "source_created_at", "42");
    expect(sql).toContain("SELECT MIN(source_created_at) as mn, MAX(source_created_at) as mx");
    expect(sql).toContain("WHERE tenant_id = 42");
  });

  it("throws for an unrecognized mode", () => {
    expect(() => buildDimensionRangeSQL("bogus", "x", "1")).toThrow();
  });
});
```

Update the import at the top of the file:

```ts
import { buildSQL, buildSnapshotSQL } from "../../src/index";
```

to:

```ts
import { buildSQL, buildSnapshotSQL, buildDimensionRangeSQL } from "../../src/index";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: FAIL with a TypeScript/import error — `buildDimensionRangeSQL` is not yet exported from `analytics/src/index.ts`.

- [ ] **Step 3: Register auth middleware for the new route**

This codebase groups all `app.use(path, authMiddleware)` registrations together near the top of the file, separate from the route handlers themselves. Replace:

```ts
app.use("/api/reports", authMiddleware);
app.use("/api/reports/*", authMiddleware);
app.use("/api/dashboards", authMiddleware);
app.use("/api/dashboards/*", authMiddleware);
app.use("/api/dashboard-items/*", authMiddleware);
```

with:

```ts
app.use("/api/reports", authMiddleware);
app.use("/api/reports/*", authMiddleware);
app.use("/api/dimension-range", authMiddleware);
app.use("/api/dashboards", authMiddleware);
app.use("/api/dashboards/*", authMiddleware);
app.use("/api/dashboard-items/*", authMiddleware);
```

- [ ] **Step 4: Implement `buildDimensionRangeSQL` and the route**

In `analytics/src/index.ts`, add this constant and function right after the `buildDatetimeDimensionBucketing` function (added in Task 2) and before `export function buildSnapshotSQL`:

```ts
const DIMENSION_RANGE_TABLES: Record<string, string> = {
  user: "uniscrm.user",
  content: "uniscrm.content",
  event: "uniscrm.event",
};

export function buildDimensionRangeSQL(mode: string, dimension: string, tenantId: string): string {
  const table = DIMENSION_RANGE_TABLES[mode];
  if (!table) throw new Error(`Unknown mode: ${mode}`);
  return `SELECT MIN(${dimension}) as mn, MAX(${dimension}) as mx FROM ${table} WHERE tenant_id = ${tenantId}`;
}
```

Then add the route. Replace:

```ts
app.delete("/api/reports/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");

  const result = await c.env.ANALYTICS_DB.prepare(
    "DELETE FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ============ Dashboards API ============
```

with:

```ts
app.delete("/api/reports/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");

  const result = await c.env.ANALYTICS_DB.prepare(
    "DELETE FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ============ Dimension Range API (sync query, for Configure popover default) ============
//
// Unlike every other R2 SQL query in this file (which run through the async
// "create report -> queue -> container executes -> write results_json ->
// frontend polls" pipeline in the Queue Handler section below), this
// endpoint queries the container directly and waits for the result inline.
// It exists only to seed a one-off best-effort suggestion for the DATETIME
// Configure popover's default selection, so the extra latency (including a
// possible container cold start) is an acceptable tradeoff here.

app.get("/api/dimension-range", async (c) => {
  const tenantId = c.get("tenantId");
  const mode = c.req.query("mode") || "";
  const dimension = c.req.query("dimension") || "";

  if (!dimension || !DIMENSION_RANGE_TABLES[mode]) {
    return c.json({ error: "Invalid mode or dimension" }, 400);
  }

  const sql = buildDimensionRangeSQL(mode, dimension, tenantId);
  const container = c.env.ANALYTICS_CONTAINER.getByName("analytics-singleton");
  await container.startAndWaitForPorts();

  const response = await container.fetch("http://container/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, warehouse: c.env.R2_WAREHOUSE, token: c.env.R2_CATALOG_TOKEN }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    return c.json({ error: `Query failed: ${errBody}` }, 502);
  }

  const result = await response.json() as { data: { mn: string | null; mx: string | null }[] };
  const row = result.data[0];
  return c.json({ min: row?.mn ?? null, max: row?.mx ?? null });
});

// ============ Dashboards API ============
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: PASS — all `buildDimensionRangeSQL` tests green, plus every pre-existing test in the file still passes.

- [ ] **Step 6: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors.

- [ ] **Step 7: Commit**

```bash
git add analytics/src/index.ts analytics/tests/unit/sql-builder.test.ts
git commit -m "feat: add GET /api/dimension-range endpoint for Configure popover default suggestion"
```

---

### Task 4: Frontend — `getDimensionRange` API wrapper + `DatetimeDimensionPopover` component

**Files:**
- Modify: `analytics/frontend/lib/api.ts`
- Create: `shared/frontend/components/DatetimeDimensionPopover.tsx`
- Test: `analytics/tests/unit/datetime-dimension-granularity.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks directly (calls the Task 3 endpoint at runtime, but has no compile-time dependency on backend code).
- Produces: `getDimensionRange(mode: string, dimension: string): Promise<{ min: string | null; max: string | null }>` (in `analytics/frontend/lib/api.ts`). `DatetimeGranularity` (type: `"none" | "hour" | "day" | "week" | "month" | "quarter"`), `suggestGranularity(min: string | null, max: string | null): DatetimeGranularity` (pure, exported, unit-tested), and `DatetimeDimensionPopover` (component) — all in `shared/frontend/components/DatetimeDimensionPopover.tsx`. Task 5 imports `DatetimeDimensionPopover`, `DatetimeGranularity`, and `getDimensionRange` to wire this into `ReportConfig.tsx`.

- [ ] **Step 1: Write the failing tests for `suggestGranularity`**

Create `analytics/tests/unit/datetime-dimension-granularity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { suggestGranularity } from "../../../shared/frontend/components/DatetimeDimensionPopover";

describe("suggestGranularity", () => {
  it("suggests 'none' when min or max is missing", () => {
    expect(suggestGranularity(null, null)).toBe("none");
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", null)).toBe("none");
  });

  it("suggests 'none' for a single data point (min === max)", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("none");
  });

  it("suggests 'hour' for a span under 2 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z")).toBe("hour");
  });

  it("suggests 'day' for a span under 60 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-02-15T00:00:00.000Z")).toBe("day");
  });

  it("suggests 'week' for a span under 365 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z")).toBe("week");
  });

  it("suggests 'month' for a span under 2 years", () => {
    expect(suggestGranularity("2024-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z")).toBe("month");
  });

  it("suggests 'quarter' for a span over 2 years", () => {
    expect(suggestGranularity("2020-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("quarter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd analytics && npx vitest run tests/unit/datetime-dimension-granularity.test.ts`
Expected: FAIL — the module `shared/frontend/components/DatetimeDimensionPopover` does not exist yet.

- [ ] **Step 3: Add `getDimensionRange` to `analytics/frontend/lib/api.ts`**

Add this function anywhere after the `recomputeReport` function (e.g. right before the `// ============ Dashboards ============` comment):

```ts
export function getDimensionRange(mode: string, dimension: string) {
  return request<{ min: string | null; max: string | null }>(
    `/api/dimension-range?mode=${mode}&dimension=${dimension}`
  );
}
```

- [ ] **Step 4: Create `shared/frontend/components/DatetimeDimensionPopover.tsx`**

```tsx
import { useState, useEffect } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import type { Locale } from "../../../metadata/locale";

export type DatetimeGranularity = "none" | "hour" | "day" | "week" | "month" | "quarter";

interface DatetimeDimensionPopoverProps {
  dimension: string;
  mode: string; // "user" | "content" | "event"
  value?: DatetimeGranularity;
  onChange: (next: DatetimeGranularity) => void;
  // Injected rather than imported directly, so this shared component never
  // depends on a specific module's API client (analytics/frontend/lib/api.ts).
  fetchRange: (mode: string, dimension: string) => Promise<{ min: string | null; max: string | null }>;
  locale?: Locale;
}

const UI = {
  en: {
    configure: "Configure",
    title: "Choose granularity",
    none: "No aggregation",
    hour: "Hour",
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
    confirm: "Confirm",
  },
  zh: {
    configure: "配置",
    title: "选择汇总粒度",
    none: "不汇总",
    hour: "小时",
    day: "天",
    week: "周",
    month: "月",
    quarter: "季度",
    confirm: "确定",
  },
};

const OPTIONS: DatetimeGranularity[] = ["none", "hour", "day", "week", "month", "quarter"];

// Suggests an initial granularity from a field's actual [min, max]
// timestamp span — used only to pre-select a radio the first time the
// popover opens for a dimension with no saved choice yet. Once the user
// picks (or confirms) an option, it becomes a fixed, persisted choice like
// any other config field; this function is never consulted again for that
// report.
export function suggestGranularity(min: string | null, max: string | null): DatetimeGranularity {
  if (!min || !max) return "none";
  const spanMs = new Date(max).getTime() - new Date(min).getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return "none";
  const day = 86400000;
  if (spanMs <= 2 * day) return "hour";
  if (spanMs <= 60 * day) return "day";
  if (spanMs <= 365 * day) return "week";
  if (spanMs <= 2 * 365 * day) return "month";
  return "quarter";
}

export function DatetimeDimensionPopover({ dimension, mode, value, onChange, fetchRange, locale = "en" }: DatetimeDimensionPopoverProps) {
  const s = UI[locale];
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<DatetimeGranularity>(value || "none");
  const [range, setRange] = useState<{ min: string | null; max: string | null } | null>(null);

  // Eagerly prefetch the field's range as soon as it's selected as the
  // dimension (not gated on the popover being open), so the suggestion is
  // usually already available by the time the user opens Configure.
  useEffect(() => {
    setRange(null);
    fetchRange(mode, dimension).then(setRange).catch(() => setRange(null));
  }, [mode, dimension, fetchRange]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraftValue(value || (range ? suggestGranularity(range.min, range.max) : "none"));
    }
    setOpen(next);
  };

  const confirm = () => {
    onChange(draftValue);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs text-primary hover:underline ml-2">
          ⚙️ {s.configure}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">{s.title}</span>
        </div>
        <div className="space-y-2 text-sm">
          {OPTIONS.map((opt) => (
            <label key={opt} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={draftValue === opt} onChange={() => setDraftValue(opt)} />
              {s[opt]}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={confirm}>{s.confirm}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd analytics && npx vitest run tests/unit/datetime-dimension-granularity.test.ts`
Expected: PASS — all 7 `suggestGranularity` tests green.

- [ ] **Step 6: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline (a handful of new `TS7016`/`TS7006` "missing @types/react" lines are expected for this new `.tsx` file, matching the same systemic class every other new component in this repo has produced — no new error *category*).

- [ ] **Step 7: Commit**

```bash
git add analytics/frontend/lib/api.ts shared/frontend/components/DatetimeDimensionPopover.tsx analytics/tests/unit/datetime-dimension-granularity.test.ts
git commit -m "feat: add DatetimeDimensionPopover component and getDimensionRange API wrapper"
```

---

### Task 5: Wire `DatetimeDimensionPopover` into `ReportConfig.tsx`

**Files:**
- Modify: `analytics/frontend/components/ReportConfig.tsx`

**Interfaces:**
- Consumes: `IntDimensionPopover` (Task 1), `DatetimeDimensionPopover`/`DatetimeGranularity` (Task 4, from `shared/frontend/components/DatetimeDimensionPopover`), `getDimensionRange` (Task 4, from `../lib/api`).
- Produces: `ReportConfigValues.dimensionDateGranularity?: DatetimeGranularity`. Task 6 reads/writes this field in `AnalyticsDetail.tsx`.

- [ ] **Step 1: Add imports**

Add these two imports to `analytics/frontend/components/ReportConfig.tsx`, alongside the existing `IntDimensionPopover` import:

```tsx
import { DatetimeDimensionPopover, type DatetimeGranularity } from "../../../shared/frontend/components/DatetimeDimensionPopover";
import { getDimensionRange } from "../lib/api";
```

- [ ] **Step 2: Add `dimensionDateGranularity` to `ReportConfigValues`**

Replace:

```ts
export interface ReportConfigValues {
  mode?: "event" | "interval" | "user" | "content" | "funnel";
  eventType: string;
  measure: "count" | "users" | "avg" | "sum";
  measureField?: string;
  eventTypeA?: string;
  eventTypeB?: string;
  dimension: string;
  dimensionBucketMode?: BucketMode;
  buckets?: string;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
```

with:

```ts
export interface ReportConfigValues {
  mode?: "event" | "interval" | "user" | "content" | "funnel";
  eventType: string;
  measure: "count" | "users" | "avg" | "sum";
  measureField?: string;
  eventTypeA?: string;
  eventTypeB?: string;
  dimension: string;
  dimensionBucketMode?: BucketMode;
  buckets?: string;
  dimensionDateGranularity?: DatetimeGranularity;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
```

- [ ] **Step 3: Add the `selectedDimensionIsDatetime` check**

Replace:

```ts
  const selectedDimensionIsInt = PROPS.find((p) => p.propId === values.dimension)?.dataType === "INT";
```

with:

```ts
  const selectedDimensionIsInt = PROPS.find((p) => p.propId === values.dimension)?.dataType === "INT";
  const selectedDimensionIsDatetime = PROPS.find((p) => p.propId === values.dimension)?.dataType === "DATETIME";
```

- [ ] **Step 4: Reset `dimensionDateGranularity` on dimension change, and render the popover**

Replace:

```tsx
              {mode === "user" || mode === "content" ? (
                <SelectProps
                  options={entityProps}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              ) : (
                <SelectProps
                  options={eventPropsFor(mode === "interval" ? (values.eventTypeA || "") : values.eventType)}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              )}
              {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
                <IntDimensionPopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
```

with:

```tsx
              {mode === "user" || mode === "content" ? (
                <SelectProps
                  options={entityProps}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined, dimensionDateGranularity: undefined })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              ) : (
                <SelectProps
                  options={eventPropsFor(mode === "interval" ? (values.eventTypeA || "") : values.eventType)}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "", dimensionBucketMode: undefined, dimensionDateGranularity: undefined })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              )}
              {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
                <IntDimensionPopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
              {values.dimension && selectedDimensionIsDatetime && mode !== "interval" && (
                <DatetimeDimensionPopover
                  dimension={values.dimension}
                  mode={mode}
                  value={values.dimensionDateGranularity}
                  onChange={(v) => update({ dimensionDateGranularity: v })}
                  fetchRange={getDimensionRange}
                  locale={locale}
                />
              )}
```

- [ ] **Step 5: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors. A dimension is only ever one `dataType`, so `selectedDimensionIsInt` and `selectedDimensionIsDatetime` are never both true — the two popovers never render simultaneously.

- [ ] **Step 6: Commit**

```bash
git add analytics/frontend/components/ReportConfig.tsx
git commit -m "feat: wire DatetimeDimensionPopover into ReportConfig for DATETIME dimensions"
```

---

### Task 6: Wire `dimension_date_granularity` through `AnalyticsDetail.tsx`

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`

**Interfaces:**
- Consumes: `ReportConfigValues.dimensionDateGranularity` (Task 5).
- Produces: `dimension_date_granularity` in the wire-format params sent to the backend for User/Content and Event modes, and restored from a saved report's params — completing the round-trip Task 2's backend dispatch relies on.

- [ ] **Step 1: Restore `dimensionDateGranularity` from a saved report**

Replace:

```ts
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        sortColumn: p.sort_column || "dimension",
```

with:

```ts
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        dimensionDateGranularity: p.dimension_date_granularity || undefined,
        sortColumn: p.sort_column || "dimension",
```

- [ ] **Step 2: Thread it through `buildReportParams`'s User/Content branch**

Replace:

```ts
    if (mode === "user" || mode === "content") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        dimension_bucket_mode: config.dimensionBucketMode || undefined,
        buckets: buckets?.length ? buckets : undefined,
        filters: config.filters,
        chart_type: chartType,
        sort_column: config.sortColumn || "dimension",
        sort_direction: config.sortDirection || "asc",
      };
    }
```

with:

```ts
    if (mode === "user" || mode === "content") {
      const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
      return {
        measure: config.measure,
        measure_field: config.measureField || undefined,
        dimension: config.dimension || undefined,
        dimension_bucket_mode: config.dimensionBucketMode || undefined,
        buckets: buckets?.length ? buckets : undefined,
        dimension_date_granularity: config.dimensionDateGranularity || undefined,
        filters: config.filters,
        chart_type: chartType,
        sort_column: config.sortColumn || "dimension",
        sort_direction: config.sortDirection || "asc",
      };
    }
```

- [ ] **Step 3: Thread it through `buildReportParams`'s Event (final) branch**

Replace:

```ts
    const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
    return {
      event_type: config.eventType,
      measure: config.measure,
      dimension: config.dimension || undefined,
      dimension_bucket_mode: config.dimensionBucketMode || undefined,
      buckets: buckets?.length ? buckets : undefined,
      granularity: config.granularity,
      time_range: config.timeRange,
      time_range_start: start,
      compare_enabled: !!config.compareEnabled,
      compare_time_range: config.compareTimeRange || undefined,
      filters: config.filters,
      chart_type: chartType,
      sort_column: config.sortColumn || "dimension",
      sort_direction: config.sortDirection || "asc",
    };
  }, [config, mode, chartType]);
```

with:

```ts
    const buckets = config.buckets ? config.buckets.split(",").map(Number).filter(n => !isNaN(n) && n > 0) : undefined;
    return {
      event_type: config.eventType,
      measure: config.measure,
      dimension: config.dimension || undefined,
      dimension_bucket_mode: config.dimensionBucketMode || undefined,
      buckets: buckets?.length ? buckets : undefined,
      dimension_date_granularity: config.dimensionDateGranularity || undefined,
      granularity: config.granularity,
      time_range: config.timeRange,
      time_range_start: start,
      compare_enabled: !!config.compareEnabled,
      compare_time_range: config.compareTimeRange || undefined,
      filters: config.filters,
      chart_type: chartType,
      sort_column: config.sortColumn || "dimension",
      sort_direction: config.sortDirection || "asc",
    };
  }, [config, mode, chartType]);
```

(The `funnel` and `interval` branches are intentionally left untouched — DATETIME dimension configuration is out of scope for both, matching the existing INT bucketing scope.)

- [ ] **Step 4: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors.

- [ ] **Step 5: Commit**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "feat: persist DATETIME dimension granularity into report config and params"
```

---

### Task 7: Manual verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Push and deploy**

Push the accumulated commits from Tasks 1-6 to `main` (pushing to `main` auto-deploys to the `dev` Cloudflare environment via GitHub Actions). Confirm the `analytics` deploy job succeeds:

```bash
git push origin main
gh run list --workflow=deploy-dev.yml --limit=1
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name | contains("analytics")) | {name, conclusion}'
```

Expected: `"conclusion": "success"`.

- [ ] **Step 2: Verify the Configure button appears for a DATETIME dimension**

On `https://analytics-dev.uni-scrm.com/analytics`, create (or open) a Content Analytics report and select "Posted at" (`source_created_at`) as the dimension. Confirm the `⚙️配置` button renders inline, immediately right of the dimension dropdown (same placement as the INT version).

- [ ] **Step 3: Verify the data-driven default suggestion**

Open the Configure popover for the first time on this dimension. Via the Network tab, confirm a request to `/api/dimension-range?mode=content&dimension=source_created_at` fired (it should have fired as soon as "Posted at" was selected, before the popover was even opened) and returned real `min`/`max` values. Confirm the pre-checked radio option matches the threshold rule for that real span (e.g. if the tenant's content spans several years, "季度" should be pre-checked).

- [ ] **Step 4: Verify choosing a granularity recomputes the report**

Pick "天" (Day) and confirm. Verify the report recomputes (a "Computing..." state appears, `status` transitions through `pending`/`computing` back to `ready`) — unlike the sort feature, this must NOT be a cosmetic no-op change. Once computed, expand "SQL Query" (or inspect the report's stored `sql` field) and confirm it contains `DATE_TRUNC('day', source_created_at)`.

- [ ] **Step 5: Verify "不汇总" and persistence**

Switch back to "不汇总" and confirm — verify the SQL reverts to grouping by the raw `source_created_at` column (no `DATE_TRUNC`). Save the report, reload the page, reopen the Configure popover, and confirm it shows "不汇总" as checked (not a freshly recomputed suggestion) — the persisted choice, not the data-driven default, wins on reopen.

- [ ] **Step 6: Verify `IntDimensionPopover` still works (regression check for the rename)**

Open an existing User or Content Analytics report with an INT dimension (e.g. "Followers") and confirm its `⚙️配置` popover (discrete/default/custom modes, chained interval editor) still functions exactly as before the rename.

- [ ] **Step 7: Report results**

Summarize pass/fail for Steps 2-6, including any screenshots or network-request evidence gathered — in particular, explicitly note whether `DATE_TRUNC('quarter', ...)` executed successfully against real R2 SQL (this specific truncation unit is new to this codebase and hasn't been exercised in production before; `hour`/`day`/`week`/`month` are already proven via the existing event-report granularity feature).
