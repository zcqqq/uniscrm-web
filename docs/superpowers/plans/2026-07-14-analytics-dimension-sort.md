# Analytics Results Sorting + Configure Button Reposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every analytics report-results table column click-to-sort (with the chart above it reordering in lockstep), default to dimension-ascending, persist the choice into the report's saved config, and move the INT-dimension `⚙️配置` button inline next to the dimension dropdown.

**Architecture:** `ResultsTable` (shared component) gains an optional **controlled** sort mode (`sortKey`/`sortDir`/`onSortChange` props) alongside new per-column `sortable`/`sortType` flags, reusing `DataTable.tsx`'s `compareRows` comparator (extended with one new case for bucket-range-string labels). `AnalyticsDetail.tsx` owns the sort state (as part of its existing `ReportConfigValues` `config` state, so it round-trips through the same save/restore/patch machinery as `chart_type`), applies the comparator to the arrays that feed both the chart and the table before rendering either, and threads `sort_column`/`sort_direction` through `buildReportParams` and the backend's cosmetic-field allowlist so a sort change persists on Save without ever triggering recomputation.

**Tech Stack:** React (analytics/shared frontend), TypeScript, Vitest (pure-function unit tests only — this repo has no frontend component test infra, per prior tasks' findings), Hono backend (`analytics/src/index.ts`), Cloudflare Workers.

## Global Constraints

- Scope: sorting applies only to User/Content mode's snapshot results and Event mode's time-series results. Interval and Funnel results are unaffected (spec section 2, "Scope").
- Comparator rules for the "Dimension" column: discrete-mode `INT`/`DATETIME` values compare numerically/chronologically; bucketed range-string labels (`"100-1000"`, `"1000+"`) compare by their extracted lower bound; everything else compares as strings (spec section 2).
- "Value"/"%" columns always compare numerically. Event mode's "Period" column compares chronologically (spec section 2).
- Default sort is `dimension` ascending, applied even before any user interaction — not "no sort until clicked" (spec section 2).
- `ResultsTable`'s sort state must be **controlled by the parent** (`AnalyticsDetail`), not owned internally like `DataTable` — the chart above the table needs to observe the same resolved order (spec section 3, `CONTEXT.md`'s "Controlled vs uncontrolled sort" entry).
- Reuse `compareRows` from `shared/frontend/components/DataTable.tsx`; do not reimplement comparison logic (spec section 3).
- New `ReportConfigValues` fields: `sortColumn?: string`, `sortDirection?: "asc" | "desc"`; wire format `sort_column`/`sort_direction`; added to backend `COSMETIC_PARAM_FIELDS` so sorting never triggers recompute (spec section 4).
- The `⚙️配置` (`BucketModePopover`) trigger moves into the same `flex items-center gap-2` row as the dimension dropdown, immediately after it (spec section 1).

---

### Task 1: Extend `compareRows` for bucket-range-string numeric sorting

**Files:**
- Modify: `shared/frontend/components/DataTable.tsx:45-78`
- Test: `analytics/tests/unit/data-table-sort.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only changes `compareRows`'s internal number-parsing behavior.
- Produces: `compareRows<T>(a, b, sortKey, sortType, sortDir)` (signature unchanged) now correctly orders values like `"100-1000"` and `"1000+"` by their leading number instead of treating them as unparseable (previously: `Number("100-1000")` is `NaN`, which the existing code already sorts to the end — this task fixes that so such labels sort by their numeric lower bound instead of always landing last). Later tasks (5 and 6) rely on this behavior when sorting the "Dimension" column for INT props, discrete or bucketed.

- [ ] **Step 1: Write the failing tests**

Add to the end of `analytics/tests/unit/data-table-sort.test.ts` (inside the existing `describe("compareRows", ...)` block, after the last `it(...)`):

```ts
  it("sorts bucket-range-string labels by their extracted lower bound", () => {
    // "100-1000" and "1000+" are produced by the "default"/"custom" INT
    // bucket modes (see BucketModePopover) — Number() on these strings is
    // NaN, so without special handling they'd all be treated as missing
    // and sort last. They must instead sort by their leading number.
    const rows = [
      { id: "a", bucket: "100-1000" },
      { id: "b", bucket: "1000+" },
      { id: "c", bucket: "0-100" },
    ];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, "bucket", "number", "asc"));
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("still sorts missing bucket-range values last", () => {
    const rows = [
      { id: "a", bucket: "100-1000" },
      { id: "b", bucket: null as unknown as string },
      { id: "c", bucket: "0-100" },
    ];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, "bucket", "number", "asc"));
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/data-table-sort.test.ts`
Expected: the 2 new tests FAIL (both `"100-1000"` and `"1000+"` currently parse to `NaN` and get shoved to the end regardless of their true order — `sorted.map(r => r.id)` will come back as `["c", "a", "b"]` only by accident of insertion order for the missing-handling case, but the first new test will fail because `"1000+"` and `"100-1000"` both hit the `Number.isNaN(bn)` branch and neither is treated as strictly greater than the other in a meaningful way — expect a mismatch against `["c", "a", "b"]`).

- [ ] **Step 3: Implement the fix**

In `shared/frontend/components/DataTable.tsx`, add a helper function immediately above `compareRows` (after the `Missing values always sort...` comment block, before `export function compareRows`):

```ts
// Extracts the leading number from a bucket-range label produced by
// analytics' "default"/"custom" INT bucket modes (e.g. "100-1000", "1000+"),
// so range labels sort by their lower bound instead of being treated as
// unparseable (which would otherwise sort them all to the end as "missing").
function parseLeadingNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v);
  const direct = Number(s);
  if (!Number.isNaN(direct)) return direct;
  const m = s.match(/^-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
```

Then replace the `sortType === "number"` branch inside `compareRows`:

```ts
  if (sortType === "number") {
    const an = av === "" ? NaN : Number(av);
    const bn = bv === "" ? NaN : Number(bv);
```

with:

```ts
  if (sortType === "number") {
    const an = av === "" ? NaN : parseLeadingNumber(av);
    const bn = bv === "" ? NaN : parseLeadingNumber(bv);
```

(the rest of the branch — the `Number.isNaN` missing-value handling and the final `return` — is unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/data-table-sort.test.ts`
Expected: PASS, all 6 tests (4 existing + 2 new) green. Also re-run the existing "sorts numerically for sortType 'number', even when the value arrives as a string" test in the same run to confirm no regression — `Number("9")`/`Number("10")` still parse directly via the `direct` branch before the regex fallback is ever reached.

- [ ] **Step 5: Commit**

```bash
git add shared/frontend/components/DataTable.tsx analytics/tests/unit/data-table-sort.test.ts
git commit -m "feat: sort bucket-range-string labels by their extracted lower bound"
```

---

### Task 2: `ResultsTable` gains controlled, clickable column sorting

**Files:**
- Modify: `shared/frontend/components/ResultsTable.tsx` (full file, currently 54 lines)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ResultsTableColumn<T>` now has optional `sortable?: boolean` and `sortType?: "number" | "date"`. `ResultsTableProps<T>` now has optional `sortKey?: string`, `sortDir?: "asc" | "desc"` (default `"asc"` when omitted), and `onSortChange?: (key: string, dir: "asc" | "desc") => void`. Tasks 5 and 6 pass these props from `AnalyticsDetail.tsx`; when `onSortChange` is omitted, headers render without sort affordance (non-breaking for the Interval/Funnel tables, which are not touched by this feature and keep calling `ResultsTable` with only `title`/`columns`/`rows`).
- No unit test infra exists for this file's rendering (frontend components in this repo are typecheck-only verified, per Tasks 3/4's reports) — verification is via `npm run typecheck` (no regression) plus Task 7's manual browser check.

- [ ] **Step 1: Implement the change**

Replace the full contents of `shared/frontend/components/ResultsTable.tsx` with:

```tsx
import type { ReactNode } from "react";
import { Card, CardContent } from "../ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";

export interface ResultsTableColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  sortable?: boolean;
  // Same shape as DataTable.Column["sortType"] — makes the comparison
  // explicit rather than inferring it from typeof at sort time.
  sortType?: "number" | "date";
  render?: (row: T) => ReactNode;
}

export interface ResultsTableProps<T extends Record<string, unknown>> {
  title: string;
  columns: ResultsTableColumn<T>[];
  rows: T[];
  // Controlled sort state — unlike DataTable (which owns sort state
  // internally), ResultsTable's caller (AnalyticsDetail) needs the same
  // resolved order to also reorder the chart rendered above the table, so
  // the state has to live in the parent where both can read it. See
  // CONTEXT.md's "Controlled vs uncontrolled sort" entry.
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSortChange?: (key: string, dir: "asc" | "desc") => void;
}

export function ResultsTable<T extends Record<string, unknown>>({
  title,
  columns,
  rows,
  sortKey,
  sortDir = "asc",
  onSortChange,
}: ResultsTableProps<T>) {
  const handleClick = (col: ResultsTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    if (sortKey === col.key) {
      onSortChange(col.key, sortDir === "asc" ? "desc" : "asc");
    } else {
      onSortChange(col.key, "asc");
    }
  };

  return (
    <Card className="mb-4">
      <CardContent className="p-6 pt-4 pb-0">
        <p className="text-sm font-medium text-foreground mb-2">{title}</p>
      </CardContent>
      <div className="border-t border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={[
                    col.align === "right" ? "text-right" : "",
                    col.sortable && onSortChange ? "cursor-pointer select-none hover:bg-muted/50" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={col.sortable ? () => handleClick(col) : undefined}
                >
                  {col.label}
                  {col.sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={col.align === "right" ? "text-right tabular-nums" : ""}
                  >
                    {col.render ? col.render(row) : String(row[col.key] ?? "—")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
```

Note: a newly-clicked column defaults to ascending (`onSortChange(col.key, "asc")`), which deliberately differs from `DataTable`'s own uncontrolled convention (new column → `"desc"`) — `ResultsTable`'s default *unclicked* state is already ascending (per spec section 2), so ascending-first on click keeps the behavior consistent/predictable rather than surprising the user with an initial flip to descending.

- [ ] **Step 2: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same error count/content as the pre-existing baseline (all `TS7016`/`TS7006` "missing `@types/react`" errors, per every prior task's typecheck methodology in this repo) — no new error referencing `ResultsTable.tsx` beyond that same pre-existing class. Existing callers (Interval/Funnel results tables in `AnalyticsDetail.tsx`, which pass only `title`/`columns`/`rows`) must still typecheck cleanly since all new props are optional.

- [ ] **Step 3: Commit**

```bash
git add shared/frontend/components/ResultsTable.tsx
git commit -m "feat: ResultsTable supports controlled, clickable column sorting"
```

---

### Task 3: Move the `⚙️配置` (BucketModePopover) trigger inline next to the dimension dropdown

**Files:**
- Modify: `analytics/frontend/components/ReportConfig.tsx:228-260`

**Interfaces:**
- Consumes: existing `BucketModePopover` component (unchanged) and `selectedDimensionIsInt`/`values.dimension`/`values.dimensionBucketMode`/`values.buckets` (all pre-existing).
- Produces: no new interfaces — purely a JSX layout change. Unrelated to sorting; safe to do independently of Tasks 1/2/4/5/6.

- [ ] **Step 1: Implement the change**

In `analytics/frontend/components/ReportConfig.tsx`, replace:

```tsx
          <div className="flex-1 min-w-[200px]">
            <Label className="mb-2 block">{s.dimension}</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{s.viewBy}</span>
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
            </div>
            {values.dimension && selectedDimensionIsInt && mode !== "interval" && (
              <div className="mt-2">
                <BucketModePopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              </div>
            )}
          </div>
```

with:

```tsx
          <div className="flex-1 min-w-[200px]">
            <Label className="mb-2 block">{s.dimension}</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{s.viewBy}</span>
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
                <BucketModePopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              )}
            </div>
          </div>
```

- [ ] **Step 2: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing error baseline, no new errors (pure JSX relocation, no type changes).

- [ ] **Step 3: Commit**

```bash
git add analytics/frontend/components/ReportConfig.tsx
git commit -m "refactor: move bucket-mode configure button inline next to the dimension dropdown"
```

---

### Task 4: Persist sort choice into `ReportConfigValues` / report params / cosmetic-field allowlist

**Files:**
- Modify: `analytics/frontend/components/ReportConfig.tsx:73-91` (interface only)
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx:127-136,172-196,224-266`
- Modify: `analytics/src/index.ts:144`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReportConfigValues.sortColumn?: string` and `ReportConfigValues.sortDirection?: "asc" | "desc"`. `config.sortColumn`/`config.sortDirection` default to `"dimension"`/`"asc"` in initial state, in the saved-report-restore effect, and in `buildReportParams`'s User/Content and Event(final) branches as `sort_column`/`sort_direction`. Tasks 5 and 6 read `config.sortColumn`/`config.sortDirection` and call a `handleSortChange(key, dir)` function (defined in this task) that updates them.

- [ ] **Step 1: Add fields to `ReportConfigValues`**

In `analytics/frontend/components/ReportConfig.tsx`, in the `ReportConfigValues` interface, add two lines after `buckets?: string;`:

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
  timeRange: string;
  granularity: "total" | "day" | "week" | "month" | "hour" | "weekday";
  compareEnabled?: boolean;
  compareTimeRange?: string;
  filters?: FilterCondition[];
  funnelSteps?: string[];
  windowValue?: number;
  windowUnit?: "day" | "hour";
}
```

- [ ] **Step 2: Add `handleSortChange` and default sort state in `AnalyticsDetail.tsx`**

In `analytics/frontend/pages/AnalyticsDetail.tsx`, update the initial `config` state (currently):

```ts
  const [config, setConfig] = useState<ReportConfigValues>({
    mode,
    eventType: "",
    measure: "count",
    eventTypeA: "",
    eventTypeB: "",
    dimension: "",
    timeRange: "7",
    granularity: "day",
  });
```

to:

```ts
  const [config, setConfig] = useState<ReportConfigValues>({
    mode,
    eventType: "",
    measure: "count",
    eventTypeA: "",
    eventTypeB: "",
    dimension: "",
    sortColumn: "dimension",
    sortDirection: "asc",
    timeRange: "7",
    granularity: "day",
  });
```

Then, immediately after the `formatPeriod` function definition (`const formatPeriod = (p: unknown) => sharedFormatPeriod(p, config.granularity, locale, timezone);`), add:

```ts
  // ResultsTable is controlled: sort state lives here (not inside
  // ResultsTable) so both the chart above a results table and the table
  // itself can reorder from the same resolved order. Persisted into
  // config like chart_type, restored on load, PATCHed on Save.
  const sortColumn = config.sortColumn || "dimension";
  const sortDirection = config.sortDirection || "asc";
  const handleSortChange = (key: string, dir: "asc" | "desc") => {
    setConfig((prev) => ({ ...prev, sortColumn: key, sortDirection: dir }));
  };
```

- [ ] **Step 3: Restore sort fields from a saved report**

In the saved-report-restore `useEffect`, update:

```ts
      setConfig({
        mode: resolvedMode,
        eventType: p.event_type || "",
        measure: p.measure || "count",
        measureField: p.measure_field || undefined,
        eventTypeA: p.event_type_a || "",
        eventTypeB: p.event_type_b || "",
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        timeRange: typeof p.time_range === "string" && p.time_range ? p.time_range : inferTimeRange(p.time_range_start || ""),
        granularity: p.granularity || "day",
        compareEnabled: !!p.compare_enabled,
        compareTimeRange: p.compare_time_range || "7",
        filters: p.filters,
        funnelSteps: Array.isArray(p.steps) ? p.steps : undefined,
        windowValue: p.window_value || undefined,
        windowUnit: p.window_unit || undefined,
      });
```

to:

```ts
      setConfig({
        mode: resolvedMode,
        eventType: p.event_type || "",
        measure: p.measure || "count",
        measureField: p.measure_field || undefined,
        eventTypeA: p.event_type_a || "",
        eventTypeB: p.event_type_b || "",
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
        sortColumn: p.sort_column || "dimension",
        sortDirection: (p.sort_direction === "desc" ? "desc" : "asc"),
        timeRange: typeof p.time_range === "string" && p.time_range ? p.time_range : inferTimeRange(p.time_range_start || ""),
        granularity: p.granularity || "day",
        compareEnabled: !!p.compare_enabled,
        compareTimeRange: p.compare_time_range || "7",
        filters: p.filters,
        funnelSteps: Array.isArray(p.steps) ? p.steps : undefined,
        windowValue: p.window_value || undefined,
        windowUnit: p.window_unit || undefined,
      });
```

- [ ] **Step 4: Thread `sort_column`/`sort_direction` through `buildReportParams`**

In `buildReportParams`, the `mode === "user" || mode === "content"` branch currently reads:

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
      };
    }
```

Change to:

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

And the final (event-mode) branch, currently:

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
    };
  }, [config, mode, chartType]);
```

Change to:

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

(The `funnel` and `interval` branches are intentionally left untouched — sorting is out of scope for both per the Global Constraints.)

- [ ] **Step 5: Add `sort_column`/`sort_direction` to the backend's cosmetic-field allowlist**

In `analytics/src/index.ts`, change:

```ts
const COSMETIC_PARAM_FIELDS = ["chart_type", "name", "time_range_start"] as const;
```

to:

```ts
const COSMETIC_PARAM_FIELDS = ["chart_type", "name", "time_range_start", "sort_column", "sort_direction"] as const;
```

- [ ] **Step 6: Typecheck both modules**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing error baseline as prior tasks (all `TS7016`/`TS7006`), no new errors — every field added here is optional or has a default, and `p.sort_column`/`p.sort_direction` are read from an already-`any`-typed `p` (matching how every other field in that same restore block is read).

- [ ] **Step 7: Commit**

```bash
git add analytics/frontend/components/ReportConfig.tsx analytics/frontend/pages/AnalyticsDetail.tsx analytics/src/index.ts
git commit -m "feat: persist results sort choice into report config, default dimension/asc"
```

---

### Task 5: Apply sorting to User/Content mode's chart + table

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx` (imports near top; the User/Content results block, currently lines 671-755)

**Interfaces:**
- Consumes: `compareRows` from `shared/frontend/components/DataTable.tsx` (Task 1's extended version), `PROPS_X` from `../../../metadata/x`, `config.sortColumn`/`config.sortDirection`/`handleSortChange` (Task 4).
- Produces: the User/Content results chart (pie/bar) and its `ResultsTable` both render from a single `sortedData` array computed once per render, so they can never drift out of sync with each other.

- [ ] **Step 1: Add imports**

In `analytics/frontend/pages/AnalyticsDetail.tsx`, add two imports near the top, alongside the existing `import { ResultsTable } ...` line:

```ts
import { compareRows } from "../../../shared/frontend/components/DataTable";
import { PROPS_X } from "../../../metadata/x";
```

- [ ] **Step 2: Compute the dimension column's sort type**

Immediately after the `handleSortChange` block added in Task 4 Step 2, add:

```ts
  // Only INT/DATETIME dimensions get a numeric/chronological sort on the
  // "Dimension" column (bucketed INT range-strings like "100-1000" still
  // count as INT here — Task 1's compareRows extracts their lower bound).
  // Everything else (TEXT/ENUM_TEXT/ENUM_INT) falls through to compareRows'
  // plain string-compare branch by leaving sortType undefined.
  const dimensionPropDef = PROPS_X.find((p) => p.propId === config.dimension);
  const dimensionSortType: "number" | "date" | undefined =
    dimensionPropDef?.dataType === "DATETIME" ? "date" : dimensionPropDef?.dataType === "INT" ? "number" : undefined;
```

- [ ] **Step 3: Sort `data` before rendering the chart and table**

In the User/Content results block, replace:

```tsx
        {/* User/Content results — Pie/Bar chart + table (no dimension selected collapses to a single "Total" slice, same code path) */}
        {hasData && (mode === "user" || mode === "content") && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const totalLabel = mode === "content" ? t.totalContent : t.totalUsers;
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? totalLabel : (config.measureField || t.value), value: results.data[0].value }]
              : [];
          const total = data.reduce((s: number, d: any) => s + (d.value || 0), 0);
          if (data.length === 0) return null;
          return (
```

with:

```tsx
        {/* User/Content results — Pie/Bar chart + table (no dimension selected collapses to a single "Total" slice, same code path) */}
        {hasData && (mode === "user" || mode === "content") && (() => {
          const dimensioned = results.data.filter((d: any) => d.dimension != null);
          const totalLabel = mode === "content" ? t.totalContent : t.totalUsers;
          const data = dimensioned.length > 0
            ? dimensioned
            : results.data.length === 1
              ? [{ dimension: config.measure === "count" ? totalLabel : (config.measureField || t.value), value: results.data[0].value }]
              : [];
          const total = data.reduce((s: number, d: any) => s + (d.value || 0), 0);
          if (data.length === 0) return null;
          // "%" isn't a real field on each row (it's derived from value/total
          // at render time) — sorting by "%" is a monotonic transform of
          // sorting by "value" (total is always >= 0), so reuse the "value"
          // comparison for it rather than materializing a "pct" field.
          const sortTypeForColumn = sortColumn === "dimension" ? dimensionSortType : "number";
          const effectiveSortKey = sortColumn === "pct" ? "value" : sortColumn;
          const sortedData = [...data].sort((a: any, b: any) =>
            compareRows(a, b, effectiveSortKey, sortTypeForColumn, sortDirection)
          );
          return (
```

Then, still inside the same block, replace every remaining reference to `data` in the render body with `sortedData` (the chart's `Pie data={data}`, the legend `data.map`, `<ReBarChart data={data}>`, its `data.map((_: any, i) => ...)` for `Cell`s, and the table's `rows={data}` / `data.indexOf(d)`):

Replace:

```tsx
                  {chartType === "pie" ? (
                    <div className="flex items-center gap-8">
                      <ResponsiveContainer width="50%" height={280}>
                        <RePieChart>
                          <Pie data={data} dataKey="value" nameKey="dimension" cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={2}>
                            {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        </RePieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {data.map((d: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                            <span className="flex-1 truncate text-foreground">{String(d.dimension ?? "null")}</span>
                            <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span>
                            <span className="font-medium w-16 text-right">{Number(d.value).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={280}>
                      <ReBarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                        <XAxis dataKey="dimension" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {data.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                        </Bar>
                      </ReBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <ResultsTable
                title={t.data}
                columns={[
                  {
                    key: "dimension", label: t.dimension, render: (d: any) => {
                      const i = data.indexOf(d);
                      return (
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                          {String(d.dimension ?? "null")}
                        </span>
                      );
                    },
                  },
                  { key: "value", label: t.value, align: "right", render: (d: any) => Number(d.value).toLocaleString() },
                  { key: "pct", label: "%", align: "right", render: (d: any) => <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span> },
                ]}
                rows={data}
              />
            </>
          );
        })()}
```

with:

```tsx
                  {chartType === "pie" ? (
                    <div className="flex items-center gap-8">
                      <ResponsiveContainer width="50%" height={280}>
                        <RePieChart>
                          <Pie data={sortedData} dataKey="value" nameKey="dimension" cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={2}>
                            {sortedData.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        </RePieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {sortedData.map((d: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                            <span className="flex-1 truncate text-foreground">{String(d.dimension ?? "null")}</span>
                            <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span>
                            <span className="font-medium w-16 text-right">{Number(d.value).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={280}>
                      <ReBarChart data={sortedData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                        <XAxis dataKey="dimension" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {sortedData.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                        </Bar>
                      </ReBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <ResultsTable
                title={t.data}
                columns={[
                  {
                    key: "dimension", label: t.dimension, sortable: true, sortType: dimensionSortType, render: (d: any) => {
                      const i = sortedData.indexOf(d);
                      return (
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                          {String(d.dimension ?? "null")}
                        </span>
                      );
                    },
                  },
                  { key: "value", label: t.value, align: "right", sortable: true, sortType: "number", render: (d: any) => Number(d.value).toLocaleString() },
                  { key: "pct", label: "%", align: "right", sortable: true, sortType: "number", render: (d: any) => <span className="text-muted-foreground">{total ? `${Math.round(d.value / total * 100)}%` : "0%"}</span> },
                ]}
                rows={sortedData}
                sortKey={sortColumn}
                sortDir={sortDirection}
                onSortChange={handleSortChange}
              />
            </>
          );
        })()}
```

- [ ] **Step 2: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing error baseline, no new errors.

- [ ] **Step 3: Commit**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "feat: sort User/Content mode's chart and table by the selected column"
```

---

### Task 6: Apply sorting to Event mode's chart legend/series and flattened table

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx` (the Event results block, currently lines 524-614)

**Interfaces:**
- Consumes: `compareRows` (Task 1/5's import), `config.sortColumn`/`config.sortDirection`/`handleSortChange`/`dimensionSortType` (Task 4/5).
- Produces: the Event-mode chart's legend/series order and the flattened results table both derive from a single sorted `dimensions` array (for the chart) and a single sorted row array (for the table) computed once per render.

- [ ] **Step 1: Sort the `dimensions` array used for the chart's legend/series**

In `AnalyticsDetail.tsx`, immediately after the existing `dimensions` computation:

```ts
  const dimensions: string[] = hasDimension
    ? Array.from(new Set(results.data.map((d: any) => String(d.dimension ?? "null"))))
    : [];
```

add:

```ts
  // The chart's legend/series order (and DIMENSION_COLORS index assignment)
  // follows the user's sort choice only when sorting by "Dimension" itself —
  // "Value"/"Period" sorts have no single well-defined per-dimension order
  // to reorder the legend by (a dimension's value varies per period), so
  // for those the legend keeps its natural (first-seen) order while the
  // flattened table below still sorts by whichever column was chosen.
  const sortedDimensions = sortColumn === "dimension"
    ? [...dimensions].sort((a, b) => compareRows({ dimension: a }, { dimension: b }, "dimension", dimensionSortType, sortDirection))
    : dimensions;
```

- [ ] **Step 2: Use `sortedDimensions` for the chart's legend/series**

Replace every `dimensions.map(...)` inside the Event results chart block (both the `ReBarChart` and `ReLineChart` branches) with `sortedDimensions.map(...)`. Specifically, replace:

```tsx
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {dimensions.map((dim, i) => (
                            <Bar key={dim} dataKey={dim} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} radius={[3, 3, 0, 0]} />
                          ))}
                        </>
                      ) : (
                        <Bar dataKey="value" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                      )}
                    </ReBarChart>
                  ) : (
                    <ReLineChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {dimensions.map((dim, i) => {
                            const color = DIMENSION_COLORS[i % DIMENSION_COLORS.length];
```

with:

```tsx
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {sortedDimensions.map((dim, i) => (
                            <Bar key={dim} dataKey={dim} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} radius={[3, 3, 0, 0]} />
                          ))}
                        </>
                      ) : (
                        <Bar dataKey="value" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                      )}
                    </ReBarChart>
                  ) : (
                    <ReLineChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {sortedDimensions.map((dim, i) => {
                            const color = DIMENSION_COLORS[i % DIMENSION_COLORS.length];
```

- [ ] **Step 3: Sort the flattened table's rows**

Replace:

```tsx
            {eventData.length > 0 && (() => {
              const tableRows: { period: string; dimension?: string; value: number }[] = hasDimension
                ? eventData.flatMap((row: any) => dimensions.map((dim) => ({ period: row.period, dimension: dim, value: Number(row[dim]) || 0 })))
                : eventData.map((d: any) => ({ period: d.period, value: Number(d.value) || 0 }));
              return (
                <ResultsTable
                  title={t.data}
                  columns={[
                    { key: "period", label: t.period, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                    ...(hasDimension ? [{ key: "dimension", label: t.dimension, render: (d: any) => String(d.dimension ?? "—") }] : []),
                    { key: "value", label: t.value, align: "right" as const, render: (d: any) => <span className="font-medium">{d.value.toLocaleString()}</span> },
                  ]}
                  rows={tableRows}
                />
              );
            })()}
```

with:

```tsx
            {eventData.length > 0 && (() => {
              const tableRows: { period: string; dimension?: string; value: number }[] = hasDimension
                ? eventData.flatMap((row: any) => dimensions.map((dim) => ({ period: row.period, dimension: dim, value: Number(row[dim]) || 0 })))
                : eventData.map((d: any) => ({ period: d.period, value: Number(d.value) || 0 }));
              const columns = [
                { key: "period", label: t.period, sortable: true, sortType: "date" as const, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                ...(hasDimension ? [{ key: "dimension", label: t.dimension, sortable: true, sortType: dimensionSortType, render: (d: any) => String(d.dimension ?? "—") }] : []),
                { key: "value", label: t.value, align: "right" as const, sortable: true, sortType: "number" as const, render: (d: any) => <span className="font-medium">{d.value.toLocaleString()}</span> },
              ];
              // Clicking "Dimension" fully re-sorts the flattened row array
              // (one row per period x dimension) by the chosen column,
              // matching ResultsTable's single-active-sort-column model —
              // this can intermix periods, which is expected here (see
              // spec section 3), not a bug.
              const activeSortColumn = columns.some((c) => c.key === sortColumn) ? sortColumn : undefined;
              const sortedTableRows = activeSortColumn
                ? [...tableRows].sort((a: any, b: any) =>
                    compareRows(a, b, activeSortColumn, columns.find((c) => c.key === activeSortColumn)?.sortType, sortDirection)
                  )
                : tableRows;
              return (
                <ResultsTable
                  title={t.data}
                  columns={columns}
                  rows={sortedTableRows}
                  sortKey={sortColumn}
                  sortDir={sortDirection}
                  onSortChange={handleSortChange}
                />
              );
            })()}
```

- [ ] **Step 4: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing error baseline, no new errors.

- [ ] **Step 5: Commit**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "feat: sort Event mode's chart legend and flattened table by the selected column"
```

---

### Task 7: Manual verification against the real dev site

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Push and deploy**

Push the accumulated commits from Tasks 1-6 to `main` (per this repo's convention: pushing to `main` auto-deploys to the `dev` Cloudflare environment via GitHub Actions). Confirm the `deploy (analytics)` job in the resulting workflow run succeeds:

```bash
git push origin main
gh run list --workflow=deploy-dev.yml --limit=1
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name | contains("analytics")) | {name, conclusion}'
```

Expected: the `analytics` deploy job (and any job it depends on) reports `"conclusion": "success"`.

- [ ] **Step 2: Verify Configure button placement**

Open a report with an INT dimension selected (User, Content, or Event mode) on `https://analytics-dev.uni-scrm.com/analytics` via Chrome DevTools/claude-in-chrome. Confirm the `⚙️配置` icon now renders immediately to the right of the dimension dropdown, on the same row — not on its own line below.

- [ ] **Step 3: Verify User/Content sorting**

Open (or create) a User or Content Analysis report with a dimension set. Confirm:
- The table's "Dimension"/"Value"/"%" column headers show a sort indicator and are clickable.
- On first load, the table and the pie/bar chart are already ordered by Dimension ascending (no click needed).
- Clicking "Value" reorders both the table rows and the pie slices/bar order together; clicking again reverses the direction; a ↑/↓ arrow appears next to the active column.

- [ ] **Step 4: Verify Event sorting**

Open (or create) an Event Analysis report with a dimension set. Confirm:
- Clicking "Dimension" in the table reorders the chart's legend/series order (and the flattened table).
- Clicking "Value" or "Period" reorders the flattened table; the chart's x-axis (period) order is unaffected.

- [ ] **Step 5: Verify persistence without recompute**

For a saved report, click a table header to change the sort, click the toolbar "Save" button, and reload the page. Confirm:
- No "Computing..." spinner appears after Save (the PATCH request's response — inspectable via Network tab — should not flip `status` to `"pending"`).
- After reload, the table/chart restore in the sort order that was saved, not the default dimension-ascending (unless that's what was saved).
- Inspect the `params_json` for the report (via the report's GET response in the Network tab) to confirm `sort_column`/`sort_direction` are present and match the saved choice.

- [ ] **Step 6: Report results**

Summarize pass/fail for each of Steps 2-5 in the final task report, including any screenshots or network-request evidence gathered.
