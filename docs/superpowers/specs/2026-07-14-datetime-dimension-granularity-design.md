# DATETIME Dimension Granularity Configure Design

## Context

INT-typed dimensions already get a `⚙️配置` (Configure) button next to the dimension dropdown (see `shared/frontend/components/BucketModePopover.tsx`), offering discrete/default/custom bucketing. DATETIME-typed dimensions (currently only `source_created_at` — "Posted at" — on Content Analytics) have no such control: selecting one groups by the raw, full-precision timestamp, which produces one group per distinct microsecond value — effectively useless for analysis.

This feature adds an equivalent Configure control for DATETIME dimensions, letting the user choose a truncation granularity (不汇总/小时/天/周/月/季度) instead of grouping by the raw value.

## 1. Naming

`BucketModePopover` is renamed to `IntDimensionPopover` (file and export), since it is exclusively for INT dimensions and a new sibling component is being introduced for DATETIME. All references (`ReportConfig.tsx`, imports) are updated. No backward-compatible alias is kept — this is an internal, solo-maintained component.

## 2. New component: `DatetimeDimensionPopover`

`shared/frontend/components/DatetimeDimensionPopover.tsx` — a single-select popover (reusing the same `⚙️配置` trigger styling as `IntDimensionPopover`) with 6 fixed options:

| Option (zh) | Option (en) | Wire value |
|---|---|---|
| 不汇总 | No aggregation | `none` |
| 小时 | Hour | `hour` |
| 天 | Day | `day` |
| 周 | Week | `week` |
| 月 | Month | `month` |
| 季度 | Quarter | `quarter` |

**"不汇总" semantics**: group by the raw, untruncated datetime value (equivalent to today's only behavior, and to INT's "discrete" mode) — not a "collapse to one total row" behavior.

**Default pre-selection (first open only)**: the moment a DATETIME propId is selected as the dimension, `DatetimeDimensionPopover` fires a `useEffect` (independent of whether the popover is open) that calls a new endpoint to fetch the field's actual `{min, max}` timestamps for the current tenant, then — **only if no granularity has been explicitly chosen yet** (`dimensionDateGranularity` is unset) — computes a suggested pre-selected radio option from the span (`max - min`):

- span ≤ 2 days → `hour`
- span ≤ 60 days → `day`
- span ≤ 365 days → `week`
- span ≤ 2 years → `month`
- span > 2 years → `quarter`
- single data point, or `min`/`max` missing (no data) → `none`

This suggestion only affects which radio is pre-checked the first time the popover opens. Once the user picks (or confirms) an option, it is stored as an ordinary fixed choice like any other config field — it does not re-adapt on subsequent report edits or re-computations.

**Scope of the min/max query**: ignores any `filters` currently configured on the report — it queries the full, tenant-scoped range of the field. This keeps the prefetch simple and fast; it exists only to seed a reasonable initial suggestion, not to be perfectly precise.

## 3. `ReportConfig.tsx` wiring

`ReportConfigValues` gains `dimensionDateGranularity?: "none" | "hour" | "day" | "week" | "month" | "quarter"`.

When the selected dimension's `PropDefinition.dataType === "DATETIME"` (and `mode !== "interval"`, matching the existing INT gating rule), render `DatetimeDimensionPopover` inline in the same `flex items-center gap-2` row as the dimension dropdown — the same placement `IntDimensionPopover` already uses. A dimension is never both INT and DATETIME, so only one of the two popovers ever renders for a given selection.

Changing the dimension resets `dimensionDateGranularity` to `undefined` (mirroring the existing reset of `buckets`/`dimensionBucketMode` on dimension change).

## 4. Backend: new endpoint `GET /api/dimension-range`

`GET /api/dimension-range?mode=user|content|event&dimension=<propId>` — tenant-scoped via the existing auth middleware (`c.get("tenantId")`). Maps `mode` to a table (`user`→`uniscrm.user`, `content`→`uniscrm.content`, `event`→`uniscrm.event`) and runs:

```sql
SELECT MIN(<dimension>) as mn, MAX(<dimension>) as mx FROM <table> WHERE tenant_id = <tenantId>
```

Returns `{ min: string | null, max: string | null }`.

**Architectural note**: every existing R2 SQL query in this codebase runs through the async "create report → queue → container executes → write `results_json` → frontend polls" pipeline (see `handleQueueMessage` in `analytics/src/index.ts`). This endpoint introduces the first **synchronous** query path — it calls `env.ANALYTICS_CONTAINER.getByName("analytics-singleton").fetch(...)` directly inside the HTTP handler and waits for the result. This means a cold container start could add noticeable latency to opening the Configure popover for the first time in a while; accepted as a reasonable tradeoff for a one-off, non-critical-path prefetch (confirmed with the user — see grilling transcript).

## 5. Backend: split `buildDimensionBucketing`

The existing `buildDimensionBucketing` function is split into two:

- `buildIntDimensionBucketing(params: { dimension, mode?, buckets?, fromTable, tenantId, scopeFilter })` — exactly the existing discrete/default/custom logic, renamed only.
- `buildDatetimeDimensionBucketing(params: { dimension, dateGranularity?, fromTable, tenantId, scopeFilter })` — new. Returns the same `{ dimExpr, dimGroupCol, boundsCte, fromExtra }` shape:
  - `dateGranularity` in `hour`/`day`/`week`/`month`/`quarter` → `dimExpr: ", DATE_TRUNC('<unit>', <dimension>) as dimension"`, `dimGroupCol: "dimension"`.
  - `dateGranularity === "none"` or absent → `dimExpr: ", <dimension> as dimension"`, `dimGroupCol: <dimension>` (raw value, same as today's only behavior).
  - `boundsCte`/`fromExtra` are always empty strings for this function (no bounds CTE needed, unlike INT's "default" mode).

Both call sites (`buildSnapshotSQL`, and the `"event"` branch of `buildSQL`) dispatch purely on **which param the frontend sent** — no backend metadata/PROPS lookup is introduced:

- If `dimension_date_granularity` is present in `params` → call `buildDatetimeDimensionBucketing`.
- Else if `dimension_bucket_mode` or `buckets` is present → call `buildIntDimensionBucketing` (existing behavior).
- Else → today's raw/discrete fallback (unchanged).

A given `dimension` propId is only ever one dataType, so the frontend never sends both param families for the same report.

## 6. Wire format / persistence

- New field: `sortColumn`/`sortDirection`-style plain param `dimension_date_granularity`, added to `buildReportParams`'s User/Content and Event branches (mirroring exactly where `dimension_bucket_mode`/`buckets` are already sent).
- **Not** added to `COSMETIC_PARAM_FIELDS`: unlike sort or chart-type preferences, a granularity change alters the actual SQL grouping and therefore the computed result set — it must trigger recomputation, exactly like `dimension_bucket_mode`/`buckets` already do today (neither of which is in `COSMETIC_PARAM_FIELDS`).
- Restored on saved-report load the same way `dimension_bucket_mode`/`buckets` are restored today.

## Out of scope

- Sorting: `AnalyticsDetail.tsx`'s existing `dimensionSortType` logic already treats DATETIME dimensions as `sortType: "date"` for the results table/chart sort feature (a separate, already-shipped feature). A `DATE_TRUNC`-produced value is still a valid timestamp string, so no change is needed there.
- No event type currently exposes a DATETIME `eventProp` (only `source_created_at` on `content` entity exists today, reachable via Content Analytics), so the Event-mode code path for this feature is currently unexercised in production data but is still implemented symmetrically with User/Content, matching how INT bucketing was built for all three modes from the start.

## Verification

1. Selecting "Posted at" (DATETIME) as the dimension in a Content Analytics report shows the `⚙️配置` button inline next to the dropdown.
2. Opening the popover for the first time triggers a `/api/dimension-range` request and pre-selects a sensible option based on the field's actual min/max span in real data.
3. Picking "天" (Day) and confirming causes the report to recompute, grouping by day-truncated timestamps (verify via the report's SQL / result rows).
4. Reopening the popover later shows the previously chosen option, not a freshly recomputed suggestion.
5. Switching to "不汇总" groups by raw timestamp values again.
6. Changing the dimension away from a DATETIME field and back resets the granularity choice.
7. Existing INT dimension Configure behavior (`IntDimensionPopover`) is unaffected by the rename.
