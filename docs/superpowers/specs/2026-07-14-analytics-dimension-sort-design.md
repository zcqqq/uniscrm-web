# Analytics Results Sorting + Configure Button Reposition Design

## Context

Two related UI/UX improvements to the `analytics` module's report results:

1. The `⚙️配置` (bucket-mode) trigger added for INT dimensions currently sits on its own line below the dimension dropdown. It should move inline, to the right of the dropdown, so future multi-dimension pickers each get their own configure icon beside them rather than sharing one area below.
2. Dimension values shown in report results (chart + table) currently have no user-controllable sort — they render in whatever order the backend's `GROUP BY`/`ORDER BY` happened to produce (see `analytics/src/index.ts`'s existing `ORDER BY dimension` / `ORDER BY value DESC` clauses, which are backend-fixed, not user-adjustable). Every result table column should become click-to-sort, the chart above the table must reflect the same order, default to dimension-ascending, and the choice persists into the report's config so reopening the report restores it.

## 1. Configure button placement

In `ReportConfig.tsx`, move the `BucketModePopover` trigger into the same `flex items-center gap-2` row as the "View by" label and the dimension `SelectProps`, positioned immediately after the dropdown, instead of its current separate `<div className="mt-2">` below.

## 2. Sort state model

- **Scope**: applies to User/Content mode's snapshot results (pie/bar chart + table) and Event mode's time-series results (line/bar chart + table). Interval/Funnel results are unaffected (no dimension concept there).
- **Comparator rules** for the "Dimension" column specifically:
  - Discrete-mode `INT`/`DATETIME` values: numeric / chronological compare.
  - Bucketed range-string labels (`"100-1000"`, `"1000+"`, produced by `default`/`custom` bucket modes): numeric compare on the extracted lower bound.
  - Everything else (`TEXT`/`ENUM_TEXT`/`ENUM_INT` discrete values): string compare.
- "Value" and "%" columns: always numeric compare. Event mode's "Period" column: chronological compare.
- **Default**: `dimension` ascending, applied even before any user interaction (not merely "no sort" until clicked).

## 3. Component architecture: `ResultsTable` gains controlled sort

- `ResultsTableColumn<T>` gains optional `sortable?: boolean` and `sortType?: "number" | "date"` — same shape as `DataTable.Column`, for consistency.
- Unlike `DataTable` (which owns sort state internally, since nothing else needs to observe it), `ResultsTable`'s sort state is **controlled by the parent** (`AnalyticsDetail`): `sortKey`/`sortDir` passed as props, plus an `onSortChange(key, dir)` callback fired on header click. This is a deliberate deviation from `DataTable`'s uncontrolled pattern — `AnalyticsDetail` needs the same resolved order to also reorder the chart above the table, so the state has to live where both can read it.
- The comparator reuses `compareRows` from `shared/frontend/components/DataTable.tsx` (no reimplementation), extended with one new case: when `sortType === "number"` and a cell value matches a bucket-range string shape (`"<num>-<num>"` or `"<num>+"`), extract and compare the leading number instead of the whole string.
- **User/Content mode**: the resolved sort reorders the actual `data` array that both the pie/bar chart and the table render from — they move together automatically since both consume the same array.
- **Event mode**: the resolved sort reorders the `dimensions: string[]` array (drives legend entries, `Bar`/`Line` series order, and `DIMENSION_COLORS` index assignment) — the x-axis remains period/chronological, unaffected. The results table (one row per period×dimension) becomes a single flat sortable list: clicking "Dimension" fully re-sorts the flattened row array by the chosen column (matching `DataTable`'s single-active-sort-column model), which can intermix periods — this is expected, not a bug, given the "all columns clickable, one active sort" model this design adopts throughout.

## 4. Persistence

- New `ReportConfigValues` fields: `sortColumn?: string`, `sortDirection?: "asc" | "desc"`.
- Wire format: `sort_column` / `sort_direction`, added to `buildReportParams`'s output for User/Content and Event modes, alongside the existing `chart_type`.
- Added to the backend's `COSMETIC_PARAM_FIELDS` list (`analytics/src/index.ts`) so a sort change persists via `PATCH` immediately without ever triggering recomputation — identical to how `chart_type` already behaves.
- Restored in the saved-report-load effect; absent on old saved reports defaults to `dimension`/`asc` (the same default as a fresh report, not "no sort").

## Testing

- Unit tests for the bucket-range-string numeric extraction added to `compareRows` (or a small wrapping function), covering: plain numbers, `"<n>-<n>"` labels, `"<n>+"` labels, mixed with missing/null values (existing `compareRows` "missing sorts last" behavior must still hold).
- Manual verification in dev: for both a User/Content and an Event report with a dimension set, confirm clicking each table column header sorts the table and (for User/Content) visibly reorders pie slices/bar order, and (for Event) reorders the chart legend; confirm the sort survives a page reload of the saved report; confirm changing sort does not trigger a recompute spinner.

## Verification

1. Configure icon renders inline, immediately right of the dimension dropdown.
2. Table headers show a sort indicator (↑/↓) matching `DataTable`'s existing arrow convention; clicking toggles direction on the same column, or switches to a new column.
3. User/Content: sorting by Dimension/Value/% reorders both chart and table together.
4. Event: sorting reorders legend/series order and the flattened table; x-axis (period) order is unaffected.
5. Reopening a saved report (or a fresh default report) shows dimension-ascending by default.
6. Sort changes are persisted (visible in `params_json` via the report's PATCH) without a "Computing..." recompute flash.
