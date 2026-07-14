# INT Dimension Bucketing Design

## Context

For any INT-dataType dimension (currently only reachable in User/Content Analytics' entity-scoped dimension picker; this design extends it to Event mode's dimension picker too), the current UI is a single always-shown comma-separated text input for custom bucket boundaries — empty means "no bucketing, group by raw value." There's no way to auto-bucket, and no explicit mode toggle.

Reference: `cdp.linkflowtech.com/analytics/attr/1001892` (Linkflow CDP), researched via Chrome. When an INT dimension is selected there, a "⚙️配置" link appears next to it; clicking opens a "选择如何分组" popover with three radio options:
1. **使用离散数字(没有区间)** — discrete, no bucketing (group by raw value)
2. **默认区间** — default, backend auto-computes bucketing (exact algorithm not visible from the UI)
3. **使用自定义区间** — custom: a chained interval-row editor (`[lower, upper)` rows; first row's lower fixed at `-∞`, last row's upper fixed at `+∞`, editing one row's upper bound auto-fills the next row's lower bound; "+添加区间" adds rows, each non-first row has a remove control)

## Scope

Applies to any dimension whose `PropDefinition.dataType === "INT"`, detected via a global `PROPS_X` lookup (not the entity-scoped lookup User/Content mode currently uses) — this is what extends coverage to Event mode's dimension (an event prop) without special-casing it. Interval mode has no dimension concept and is unaffected.

## 1. Data model

- `ReportConfigValues` gains `dimensionBucketMode?: "discrete" | "default" | "custom"`.
- `buckets?: number[]` (existing field, sorted ascending boundary points) is only meaningful when mode is `"custom"`.
- Backward compatibility for existing saved reports (no `dimensionBucketMode` field): non-empty `buckets` → treated as `"custom"`; empty/absent `buckets` → treated as `"discrete"`.
- `"default"` mode carries no extra client-side params — the backend derives 10 equal-width buckets from the dimension's actual min/max at query time, scoped to the same tenant/filter conditions as the rest of the query.

## 2. Frontend

- **Unify `SelectProps`**: generalize its props from `{ eventType, value, onChange, locale, placeholder }` to `{ options: PropDefinition[], value, onChange, locale, placeholder }`, built on the shared shadcn `Select` component (it currently uses a plain unstyled native `<select>`, inconsistent with the rest of the form). Keep the name `SelectProps` (per explicit preference — easy to find via search). Each call site keeps computing its own `options` exactly as today:
  - User/Content mode (`ReportConfig.tsx`): `entityProps` (entity-tag-filtered `PROPS_X`) — replaces its inline `<Select>` usage.
  - Event mode: `EventMetadata_X`'s per-event `eventProps` list resolved against `PROPS_X` — replaces `SelectProps`'s current internal `eventType`-based lookup, moving that lookup to the call site.
- **New `BucketModePopover` component** (`shared/frontend/components/`), used from both `ReportConfig.tsx`'s User/Content branch and its Event-mode dimension picker:
  - Rendered as a `⚙️配置` text link next to the dimension `SelectProps`, shown only when the selected dimension's `dataType === "INT"`.
  - Opens a `Popover` (`shared/frontend/ui/popover.tsx`) titled "选择如何分组": 3-radio group (离散数字(没有区间) / 默认区间 / 使用自定义区间); selecting "自定义区间" reveals the chained interval-row editor inline (first row `[-∞, <input>)`, middle rows `[<auto-filled>, <input>)`, last row `[<auto-filled>, +∞)`, "+ 添加区间" / row-remove controls, boundaries chained as described above).
  - A "确定" button commits `dimensionBucketMode` (+ `buckets` for custom) into `ReportConfigValues` and closes the popover.
- The old flat comma-separated bucket `Input` in `ReportConfig.tsx` is removed, replaced by this popover.

## 3. Backend

- **`buildSnapshotSQL`** (User/Content, `analytics/src/index.ts`): add a `"default"` branch alongside the existing custom/discrete handling — wrap the query in `WITH bounds AS (SELECT MIN(<dim>) mn, MAX(<dim>) mx FROM <table> WHERE tenant_id = ... <filters>)`, then generate 10 equal-width `CASE WHEN <dim> < mn + (mx-mn)/10*N ...` branches.
- **`buildSQL`'s `"event"` branch**: currently has no bucket support at all (bare `GROUP BY dimension`). Add the same three-way handling: discrete stays as today's behavior; custom and default are new, following the same CASE/CTE shape as the snapshot path, scoped against the same time-filtered event rows.
- Extract a shared helper, e.g. `buildBucketCaseExpr(dimension: string, boundaries: number[]): string`, used by both branches for turning a boundaries array (whether user-supplied or computed via the bounds CTE) into the CASE WHEN expression — avoids a third copy of that logic.
- New request param: `dimension_bucket_mode?: "discrete" | "default" | "custom"`, threaded through `buildReportParams` in `AnalyticsDetail.tsx` alongside the existing `dimension`/`buckets` params.

## 4. Testing

- Unit tests for `buildBucketCaseExpr` and the new `"default"` mode in both `buildSnapshotSQL` and the `"event"` branch (verify the generated SQL contains the bounds CTE and correct 10-way CASE shape).
- Unit test for `SelectProps`'s generalized `options` prop rendering correctly for both an entity-filtered list and an event-props list.
- Manual verification in dev: for both a User/Content report and an Event report, pick an INT dimension, exercise all 3 modes, confirm sensible range labels render.

## Verification

1. Selecting an INT dimension (in User/Content or Event mode) shows the `⚙️配置` link; non-INT dimensions do not.
2. All 3 modes produce correct, distinctly-labeled buckets in the resulting chart/table.
3. The chained interval editor's boundary auto-fill behavior matches the reference page exactly (edit one row's upper bound, next row's lower bound updates).
4. An old saved report with only a `buckets` array (no `dimensionBucketMode`) still renders identically to before this change.
