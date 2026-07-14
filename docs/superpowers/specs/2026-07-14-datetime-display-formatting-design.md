# Non-Locale-Dependent Date/Time Display Formatting Design

## Context

Two places in the `analytics` module render calendar dates using locale-dependent, English-month-abbreviation formatting (`toLocaleDateString(..., { month: "short", day: "numeric" })`, producing e.g. "Jun 4"):

1. **DATETIME dimension values** (new, shipped this session): when a DATETIME-typed dimension (e.g. `source_created_at` — "Posted at") is selected in User/Content or Event mode, the raw or `DATE_TRUNC`-truncated ISO timestamp string is rendered completely unformatted in the pie/bar chart legend and the results table's "Dimension" column — e.g. `2026-06-04T00:00:00.000000000Z`. This is the immediate bug that triggered this request.
2. **`formatPeriod`** (`analytics/frontend/lib/format-period.ts`, pre-existing, already shipped and working): formats the "Period" axis/column for Event and Interval reports. Its `day`/`month`/`hour`/`total` branches fall through to the same locale-dependent `month: "short"` call; its `week` branch produces a locale month-name range like "Jun 22 – Jun 28" (or "6月22-28日" in Chinese).

Both are being unified onto one non-locale-dependent, slash/dash-based numeric format.

## Format rules

- **Year**: always 2 digits (`yy`), never 4 (`yyyy`).
- **Omitting the year**: when the value's year equals the *current* year (evaluated in the report's configured display timezone, the same `timezone` param already threaded through `formatPeriod`/`formatDate` today), the year is omitted — **except** for month and quarter granularities, where the year is always shown (a bare `6` or `Q2` alone is ambiguous out of context; the day/week/hour/none granularities carry enough surrounding digits — a day number, a range, a time — to not need that same protection).
- **Separators**: `/` separates `yy`/`M`/`D` components. `-` is reserved exclusively for range compression (a week granularity's start–end).
- **Time-of-day** (`hour` and `none`/discrete granularities only): always `HH:MM:SS`, 24-hour clock, to the second — including for `hour`-truncated values, where minutes/seconds are always `:00:00` (one shared time-formatting path, no special-casing per granularity).

## Per-granularity examples (this year / a past year)

| Granularity | This year | Past year |
|---|---|---|
| 不汇总 (none, raw) | `6/4 14:23:45` | `25/6/4 14:23:45` |
| 小时 (hour) | `6/4 14:00:00` | `25/6/4 14:00:00` |
| 天 (day) | `6/4` | `25/6/4` |
| 周 (week), same month | `6/7-14` | `25/6/7-14` |
| 周 (week), crosses month, same year | `6/29-7/5` | `25/6/29-7/5` |
| 周 (week), crosses year | — | `25/12/30-26/1/5` |
| 月 (month) | `26/6` | `25/6` |
| 季度 (quarter) | `26/Q2` | `25/Q2` |

Month and quarter always include `yy` regardless of current/past year (see rule above). The week-crossing-year row is a logical extension of the confirmed same-year rules (year shown once, prefixed, when both ends share it; shown on both ends when they differ) — flagged here for explicit sign-off since it wasn't given a worked example during design.

## Scope

**In scope:**
1. The DATETIME dimension value renderer in `analytics/frontend/pages/AnalyticsDetail.tsx` — both the User/Content mode's pie/bar legend + table "Dimension" column, and the Event mode's chart legend/series labels + flattened table's "Dimension" column — for all 6 `DatetimeGranularity` values (`none`/`hour`/`day`/`week`/`month`/`quarter`).
2. `formatPeriod`'s `day`/`month`/`hour`/`total` granularity branches: replace the `toLocaleDateString(..., { month: "short", day: "numeric" })` call with the new non-locale format. This is a **format swap only** — no new information is introduced (e.g. `hour` granularity's period label still shows only the date, matching today's behavior; it does not gain an hour-of-day component, since `formatPeriod` never had one and adding it is a separate, unrelated feature request).
3. `formatPeriod`'s `week` branch: same-month/cross-month compression logic is preserved, but rebuilt on the new `M/D-D` / `M/D-M/D` numeric style instead of locale month names.

**Out of scope:**
- `formatPeriod`'s `weekday` granularity. It does not currently branch specially in `formatPeriod` at all — a period value for `weekday` granularity is a raw day-of-week integer (`0`-`6`, from the backend's `EXTRACT(DOW FROM event_time)`), which `formatPeriod` cannot parse as a date and silently falls back to `p.slice(0, 10)` (i.e. displays the bare digit). This is a pre-existing, unrelated gap — not touched by this fix.
- Any other date rendering in the codebase outside `analytics` (e.g. `shared/frontend/lib/format-time.ts`'s `formatDate`/`formatDateTime`/`formatTime`, used by `DataTable`'s `DateCell` for list-page timestamp columns across other modules) — those are a distinct, already-shipped, already-reviewed convention and not part of this request.

## Architecture

A single new shared, pure formatting function is added and consumed by both call sites, so the `M/D` / range-compression / year-omission logic is implemented exactly once:

```ts
// analytics/frontend/lib/format-compact-date.ts
export function formatCompactDate(
  iso: string,
  unit: "none" | "hour" | "day" | "week" | "month" | "quarter",
  timezone: string,
  now: Date = new Date()
): string
```

- `formatPeriod` is rewritten to delegate its `day`/`month`/`hour`/`total` branches to `formatCompactDate(p, "day", timezone)` (note: `formatPeriod`'s own `granularity` parameter values don't map 1:1 to `DatetimeGranularity` — `total`/`hour`/`weekday` are period-axis-specific concepts, not dimension-truncation units — so the mapping from `formatPeriod`'s granularity to `formatCompactDate`'s `unit` argument needs its own small table, detailed in the implementation plan) and its `week` branch to a week-range helper built on the same underlying single-date formatter.
- The new DATETIME-dimension-value renderer in `AnalyticsDetail.tsx` calls `formatCompactDate(value, dimensionDateGranularity, timezone)` directly for `hour`/`day`/`month`/`quarter`/`none`, and a week-range variant for `week` — reusing the identical helper `formatPeriod` uses internally, not a separate reimplementation.
- `now` is an injectable parameter (defaulting to `new Date()`) specifically so "is this the current year" is unit-testable without mocking global time.

## Verification

1. A Content Analytics report grouped by "Posted at" with granularity `day` shows dimension values like `6/4` (this year) in both the pie/bar legend and the table, not raw ISO strings.
2. The same report switched to `week` shows a compressed range like `6/7-14` (same month) or `6/29-7/5` (crossing month).
3. `month` and `quarter` granularities always show `yy` (e.g. `26/6`, `26/Q2`), even for the current year.
4. An Event Analysis report's existing Period column/x-axis (day/week/month/hour granularity) shows the same non-locale numeric style instead of "Jun 4" / "Jun 22 – Jun 28".
5. A report spanning into a past year shows `yy/M/D`-prefixed values for the past-year rows, while same-year rows omit the year (for day/week/hour/none granularities).
6. `weekday`-granularity period labels are unchanged (still the pre-existing raw-digit fallback) — confirming this fix didn't touch that path.
