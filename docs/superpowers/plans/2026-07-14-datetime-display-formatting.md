# Non-Locale-Dependent Date/Time Display Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every locale-dependent date rendering in the `analytics` module (the unformatted-raw-ISO DATETIME dimension values, and `formatPeriod`'s `month: "short"`-based "Jun 4" style) with one shared, non-locale-dependent, slash/dash numeric format.

**Architecture:** A new pure module `analytics/frontend/lib/format-compact-date.ts` implements the single-date and week-range formatting rules once. `formatPeriod` (`analytics/frontend/lib/format-period.ts`) is rewritten to delegate to it (dropping its now-meaningless `locale` parameter). `AnalyticsDetail.tsx` gains a `formatDimensionValue` helper built on the same module, wired into every place a DATETIME dimension's value is displayed — table cells, the manual pie-mode legend list, recharts `Legend`/`Tooltip`/`XAxis` callbacks — across both the User/Content and Event render blocks.

**Tech Stack:** React (analytics frontend), TypeScript, `Intl.DateTimeFormat` (for timezone-aware calendar-part extraction, replacing `toLocaleDateString`'s locale-tag argument), Vitest.

## Global Constraints

- Year is always 2 digits (`yy`), never 4 (`yyyy`).
- The year is omitted when it equals the *current* year (compared in the report's configured display `timezone`) — **except** for `month` and `quarter` units, which always show `yy` (a bare month number or `Q`-label alone is ambiguous without it).
- `/` separates `yy`/`M`/`D` components. `-` is reserved exclusively for range compression (a week's start–end).
- Time-of-day (`hour` and `none`/discrete units only) is always `HH:MM:SS`, 24-hour clock, to the second — including `hour`-truncated values, whose minutes/seconds are always `:00:00` (one shared time-formatting path, no per-unit special-casing).
- Per-granularity/unit examples (this year / a past year), all confirmed during design:
  - `none` (raw): `6/4 14:23:45` / `25/6/4 14:23:45`
  - `hour`: `6/4 14:00:00` / `25/6/4 14:00:00`
  - `day`: `6/4` / `25/6/4`
  - `week`, same month: `M/D-D` (e.g. `6/7-14`) / `yy/M/D-D` (e.g. `25/6/7-14`)
  - `week`, crosses month, same year: `M/D-M/D` (e.g. `6/29-7/5`) / `yy/M/D-M/D` (e.g. `25/6/29-7/5`)
  - `week`, crosses year: `yy/M/D-yy/M/D` on both sides always (e.g. `25/12/30-26/1/5`) — never omitted on either side, since the two ends are necessarily different years and omitting either would leave it ambiguous which side owns which year.
  - `month`: `26/6` / `25/6` (always `yy`)
  - `quarter`: `26/Q2` / `25/Q2` (always `yy`)
- Scope: (1) DATETIME dimension value rendering in `AnalyticsDetail.tsx` (table cells, pie-mode legend list, recharts `Legend`/`Tooltip`/`XAxis` for both User/Content and Event render blocks); (2) `formatPeriod`'s `day`/`month`/`hour`/`total` granularities (format swap only — no new information such as an hour-of-day component is introduced where none existed before) and its `week` range-compression logic.
- Out of scope: `formatPeriod`'s `weekday` granularity (pre-existing, unrelated gap — a raw day-of-week digit that already falls back to `p.slice(0, 10)` before reaching any date-formatting call; this fix must not touch that path). `shared/frontend/lib/format-time.ts`'s `formatDate`/`formatDateTime`/`formatTime` (used by `DataTable`'s `DateCell` elsewhere in the app) are a separate, already-shipped convention and are not touched.

---

### Task 1: `format-compact-date.ts` — single-date and week-range formatting

**Files:**
- Create: `analytics/frontend/lib/format-compact-date.ts`
- Test: `analytics/tests/unit/format-compact-date.test.ts`

**Interfaces:**
- Consumes: nothing new (uses only `Intl.DateTimeFormat`, built in).
- Produces: `export type CompactDateUnit = "none" | "hour" | "day" | "week" | "month" | "quarter"`; `formatCompactDate(iso: string, unit: Exclude<CompactDateUnit, "week">, timezone: string, now?: Date): string`; `formatCompactWeekRange(startIso: string, timezone: string, now?: Date): string`. Task 2 (`formatPeriod`) and Task 3/4 (`AnalyticsDetail.tsx`'s `formatDimensionValue`) both call these two functions directly — no other module reimplements this logic.

- [ ] **Step 1: Write the failing tests**

Create `analytics/tests/unit/format-compact-date.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatCompactDate, formatCompactWeekRange } from "../../frontend/lib/format-compact-date";

const NOW_2026 = new Date("2026-06-15T00:00:00.000Z");

describe("formatCompactDate", () => {
  it("formats 'none' (raw) with full time, this year", () => {
    expect(formatCompactDate("2026-06-04T14:23:45.000Z", "none", "UTC", NOW_2026)).toBe("6/4 14:23:45");
  });

  it("formats 'none' (raw) with full time, a past year", () => {
    expect(formatCompactDate("2025-06-04T14:23:45.000Z", "none", "UTC", NOW_2026)).toBe("25/6/4 14:23:45");
  });

  it("formats 'hour' with :00:00 seconds, this year", () => {
    expect(formatCompactDate("2026-06-04T14:00:00.000Z", "hour", "UTC", NOW_2026)).toBe("6/4 14:00:00");
  });

  it("formats 'hour' with :00:00 seconds, a past year", () => {
    expect(formatCompactDate("2025-06-04T14:00:00.000Z", "hour", "UTC", NOW_2026)).toBe("25/6/4 14:00:00");
  });

  it("formats 'day' with no time component, this year", () => {
    expect(formatCompactDate("2026-06-04T00:00:00.000Z", "day", "UTC", NOW_2026)).toBe("6/4");
  });

  it("formats 'day' with no time component, a past year", () => {
    expect(formatCompactDate("2025-06-04T00:00:00.000Z", "day", "UTC", NOW_2026)).toBe("25/6/4");
  });

  it("formats 'month' always with yy, this year", () => {
    expect(formatCompactDate("2026-06-01T00:00:00.000Z", "month", "UTC", NOW_2026)).toBe("26/6");
  });

  it("formats 'month' always with yy, a past year", () => {
    expect(formatCompactDate("2025-06-01T00:00:00.000Z", "month", "UTC", NOW_2026)).toBe("25/6");
  });

  it("formats 'quarter' always with yy and a Q-label, this year", () => {
    expect(formatCompactDate("2026-04-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q2");
  });

  it("formats 'quarter' always with yy and a Q-label, a past year", () => {
    expect(formatCompactDate("2025-04-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("25/Q2");
  });

  it("maps every month to the correct quarter boundary", () => {
    expect(formatCompactDate("2026-01-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q1");
    expect(formatCompactDate("2026-03-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q1");
    expect(formatCompactDate("2026-07-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q3");
    expect(formatCompactDate("2026-10-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q4");
    expect(formatCompactDate("2026-12-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q4");
  });

  it("respects the given IANA timezone when extracting calendar parts", () => {
    // 2026-06-04T23:30:00Z is already 2026-06-05 in Tokyo (UTC+9)
    expect(formatCompactDate("2026-06-04T23:30:00.000Z", "day", "Asia/Tokyo", NOW_2026)).toBe("6/5");
  });

  it("falls back to the raw input for an unparseable ISO string", () => {
    expect(formatCompactDate("not-a-date", "day", "UTC", NOW_2026)).toBe("not-a-date");
  });
});

describe("formatCompactWeekRange", () => {
  it("compresses a same-month week to M/D-D, this year", () => {
    // Monday 2026-06-08 through Sunday 2026-06-14
    expect(formatCompactWeekRange("2026-06-08T00:00:00.000Z", "UTC", NOW_2026)).toBe("6/8-14");
  });

  it("compresses a same-month week to yy/M/D-D, a past year", () => {
    expect(formatCompactWeekRange("2025-06-08T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/6/8-14");
  });

  it("expands a cross-month week to M/D-M/D, same year", () => {
    // Monday 2026-06-29 through Sunday 2026-07-05
    expect(formatCompactWeekRange("2026-06-29T00:00:00.000Z", "UTC", NOW_2026)).toBe("6/29-7/5");
  });

  it("expands a cross-month week to yy/M/D-M/D, a past year", () => {
    expect(formatCompactWeekRange("2025-06-29T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/6/29-7/5");
  });

  it("shows yy on both sides for a week crossing a year boundary", () => {
    // Monday 2025-12-30 through Sunday 2026-01-05
    expect(formatCompactWeekRange("2025-12-30T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/12/30-26/1/5");
  });

  it("falls back to the raw input for an unparseable ISO string", () => {
    expect(formatCompactWeekRange("not-a-date", "UTC", NOW_2026)).toBe("not-a-date");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/format-compact-date.test.ts`
Expected: FAIL — the module `analytics/frontend/lib/format-compact-date.ts` does not exist yet.

- [ ] **Step 3: Implement `format-compact-date.ts`**

Create `analytics/frontend/lib/format-compact-date.ts`:

```ts
// Non-locale-dependent, slash/dash numeric date formatting, shared by
// formatPeriod (the report's period axis/column) and AnalyticsDetail's
// DATETIME-dimension value renderer. See docs/superpowers/specs/
// 2026-07-14-datetime-display-formatting-design.md for the full rule set.

export type CompactDateUnit = "none" | "hour" | "day" | "week" | "month" | "quarter";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface DateParts {
  yy: number;
  M: number;
  D: number;
  h: number;
  m: number;
  s: number;
}

function getParts(iso: string, timezone: string): DateParts | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    yy: get("year") % 100,
    M: get("month"),
    D: get("day"),
    // Some environments render midnight as "24" under hour12: false.
    h: get("hour") % 24,
    m: get("minute"),
    s: get("second"),
  };
}

function currentYearInTimezone(timezone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now)) % 100;
}

/**
 * Formats a single ISO timestamp as a compact, non-locale-dependent date
 * string: `M/D` (year omitted when it matches the current year) or
 * `yy/M/D`, with an `HH:MM:SS` time suffix for "hour"/"none". "month" and
 * "quarter" always include `yy` (a bare number or Q-label alone would be
 * ambiguous). "week" is not handled here — see formatCompactWeekRange.
 */
export function formatCompactDate(
  iso: string,
  unit: Exclude<CompactDateUnit, "week">,
  timezone: string,
  now: Date = new Date()
): string {
  const parts = getParts(iso, timezone);
  if (!parts) return iso;
  const currentYear = currentYearInTimezone(timezone, now);

  if (unit === "month") return `${pad2(parts.yy)}/${parts.M}`;
  if (unit === "quarter") return `${pad2(parts.yy)}/Q${Math.ceil(parts.M / 3)}`;

  const isThisYear = parts.yy === currentYear;
  const dateStr = isThisYear ? `${parts.M}/${parts.D}` : `${pad2(parts.yy)}/${parts.M}/${parts.D}`;

  if (unit === "day") return dateStr;

  // "hour" and "none" both append a full HH:MM:SS time component — hour's
  // minutes/seconds are always :00:00, by construction of the truncation.
  const timeStr = `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}`;
  return `${dateStr} ${timeStr}`;
}

/**
 * Formats a week-granularity range: `startIso` is the week's start (Monday,
 * as produced by DATE_TRUNC('week', ...) or a period key); the end is
 * start + 6 days. Compresses to "M/D-D" within the same month, "M/D-M/D"
 * across months in the same year, and shows `yy` on both sides when the
 * range crosses a year boundary (the two ends are necessarily different
 * years, so omitting either would be ambiguous).
 */
export function formatCompactWeekRange(
  startIso: string,
  timezone: string,
  now: Date = new Date()
): string {
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return startIso;
  const end = new Date(start.getTime() + 6 * 86400000);
  const startParts = getParts(start.toISOString(), timezone);
  const endParts = getParts(end.toISOString(), timezone);
  if (!startParts || !endParts) return startIso;

  const sameYear = startParts.yy === endParts.yy;
  if (!sameYear) {
    return `${pad2(startParts.yy)}/${startParts.M}/${startParts.D}-${pad2(endParts.yy)}/${endParts.M}/${endParts.D}`;
  }

  const currentYear = currentYearInTimezone(timezone, now);
  const isThisYear = startParts.yy === currentYear;
  const prefix = isThisYear ? "" : `${pad2(startParts.yy)}/`;
  const sameMonth = startParts.M === endParts.M;

  if (sameMonth) return `${prefix}${startParts.M}/${startParts.D}-${endParts.D}`;
  return `${prefix}${startParts.M}/${startParts.D}-${endParts.M}/${endParts.D}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/format-compact-date.test.ts`
Expected: PASS, all 20 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline as prior tasks in this repo (~150-210 lines, all pre-existing "missing @types/react" errors), no new errors.

- [ ] **Step 6: Commit**

```bash
git add analytics/frontend/lib/format-compact-date.ts analytics/tests/unit/format-compact-date.test.ts
git commit -m "feat: add non-locale-dependent compact date/week-range formatting"
```

---

### Task 2: Rewrite `formatPeriod` on the new formatter, drop its `locale` parameter

**Files:**
- Modify: `analytics/frontend/lib/format-period.ts`
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx:398`
- Modify: `analytics/frontend/pages/DashboardPage.tsx:216`
- Test: `analytics/tests/unit/format-period.test.ts` (new)

**Interfaces:**
- Consumes: `formatCompactDate`, `formatCompactWeekRange` (Task 1).
- Produces: `formatPeriod(p: unknown, granularity: string, timezone: string): string` — same name, **signature changed** (the `locale: string` parameter, third positionally, is removed; `timezone` shifts from 4th to 3rd argument). Every caller must be updated in this same task — there are exactly two, both in this task's file list.

- [ ] **Step 1: Write the failing tests**

Create `analytics/tests/unit/format-period.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatPeriod } from "../../frontend/lib/format-period";

describe("formatPeriod", () => {
  it("formats a bare YYYY-MM-DD day-granularity period without a locale month name", () => {
    expect(formatPeriod("2026-06-04", "day", "UTC")).toBe("6/4");
  });

  it("formats an hour-granularity period as a date only, no time component (unchanged scope)", () => {
    expect(formatPeriod("2026-06-04T14:00:00.000Z", "hour", "UTC")).toBe("6/4");
  });

  it("formats a month-granularity period the same as day (existing behavior, format swap only)", () => {
    expect(formatPeriod("2026-06-01", "month", "UTC")).toBe("6/1");
  });

  it("formats a total-granularity period the same as day", () => {
    expect(formatPeriod("2026-06-04", "total", "UTC")).toBe("6/4");
  });

  it("compresses a same-month week range", () => {
    expect(formatPeriod("2026-06-08", "week", "UTC")).toBe("6/8-14");
  });

  it("expands a cross-month week range", () => {
    expect(formatPeriod("2026-06-29", "week", "UTC")).toBe("6/29-7/5");
  });

  it("leaves weekday-granularity values untouched (pre-existing, out-of-scope raw-digit fallback)", () => {
    expect(formatPeriod("3", "weekday", "UTC")).toBe("3");
  });

  it("returns an empty-ish fallback for a nullish period", () => {
    expect(formatPeriod(null, "day", "UTC")).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/format-period.test.ts`
Expected: FAIL — `formatPeriod` still uses the old locale-based implementation and old 4-argument signature (calling it with 3 args here means the current code receives `timezone="UTC"` as its `locale` parameter and `undefined` as `timezone`, producing "Jun 4"-style output, not "6/4").

- [ ] **Step 3: Rewrite `format-period.ts`**

Replace the full contents of `analytics/frontend/lib/format-period.ts`:

```ts
import { formatCompactDate, formatCompactWeekRange } from "./format-compact-date";

/**
 * Formats a period key (bare "YYYY-MM-DD" or full ISO timestamp) for
 * display, shared between Analytics Detail (full width, plenty of room)
 * and Dashboard widgets (compact, tighter width). Week granularity renders
 * as a compressed range ("6/8-14") to make the 7-day bucket unambiguous;
 * every other granularity renders a single date via formatCompactDate.
 *
 * "hour"/"total" granularities intentionally render as a bare date, not a
 * date+time — this preserves the exact pre-existing display (which never
 * had a time component for any granularity) while only swapping out the
 * locale-dependent month-name formatting. "weekday" granularity values are
 * a raw day-of-week digit (0-6, from the backend's EXTRACT(DOW ...)), not a
 * parseable date at all — they fall through the isNaN check below to the
 * pre-existing p.slice(0, 10) fallback, unchanged.
 */
export function formatPeriod(
  p: unknown,
  granularity: string,
  timezone: string
): string {
  if (!p || typeof p !== "string") return String(p ?? "");
  try {
    const normalized = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
    // Bare date strings (YYYY-MM-DD) must be parsed as UTC midnight
    const dateStr = normalized.includes("T") ? normalized : `${normalized}T00:00:00Z`;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return p.slice(0, 10);

    if (granularity === "week") {
      return formatCompactWeekRange(dateStr, timezone);
    }

    return formatCompactDate(dateStr, "day", timezone);
  } catch {
    return p.slice(0, 10);
  }
}
```

- [ ] **Step 4: Update the two call sites**

In `analytics/frontend/pages/AnalyticsDetail.tsx`, replace:

```ts
  const formatPeriod = (p: unknown) => sharedFormatPeriod(p, config.granularity, locale, timezone);
```

with:

```ts
  const formatPeriod = (p: unknown) => sharedFormatPeriod(p, config.granularity, timezone);
```

In `analytics/frontend/pages/DashboardPage.tsx`, replace:

```ts
  const formatTick = (p: unknown) => formatPeriod(p, granularity, locale, "UTC");
```

with:

```ts
  const formatTick = (p: unknown) => formatPeriod(p, granularity, "UTC");
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/format-period.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 6: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors. Specifically confirm no error is introduced at either of the two updated call sites (a leftover 4-argument call would now pass `timezone` where `locale` used to go, but since `formatPeriod`'s new signature only declares 3 parameters, an extra 4th argument would be silently ignored by JS at runtime, not caught by an arity check — this is why both call sites must be located and fixed in this same task, not left for later).

- [ ] **Step 7: Commit**

```bash
git add analytics/frontend/lib/format-period.ts analytics/frontend/pages/AnalyticsDetail.tsx analytics/frontend/pages/DashboardPage.tsx analytics/tests/unit/format-period.test.ts
git commit -m "refactor: rebuild formatPeriod on non-locale-dependent compact date formatting"
```

---

### Task 3: Wire `formatDimensionValue` into User/Content mode's chart + table

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`

**Interfaces:**
- Consumes: `formatCompactDate`, `formatCompactWeekRange` (Task 1); `dimensionPropDef`, `config.dimensionDateGranularity`, `timezone` (all already in scope in this component from prior work this session).
- Produces: a `formatDimensionValue(v: string): string` helper, defined once in the component and also consumed by Task 4 (Event mode). Only formats when `dimensionPropDef?.dataType === "DATETIME"`; returns the input unchanged for every other dataType (TEXT/ENUM_TEXT/ENUM_INT/INT-bucketed-range-string), so this task's changes are a no-op for every report type except DATETIME-dimensioned ones.

- [ ] **Step 1: Add the import and the `formatDimensionValue` helper**

Add to the import block near the top of `analytics/frontend/pages/AnalyticsDetail.tsx`, alongside the existing `formatPeriod as sharedFormatPeriod` import:

```ts
import { formatCompactDate, formatCompactWeekRange } from "../lib/format-compact-date";
```

Add immediately after the existing `dimensionSortType` block:

```ts
  const dimensionPropDef = PROPS.find((p) => p.propId === config.dimension);
  const dimensionSortType: "number" | "date" | undefined =
    dimensionPropDef?.dataType === "DATETIME" ? "date" : dimensionPropDef?.dataType === "INT" ? "number" : undefined;

  // Formats a DATETIME dimension's raw/DATE_TRUNC'd value into the shared
  // non-locale-dependent compact format; every other dataType (TEXT,
  // ENUM_*, INT discrete/bucketed) passes through unchanged, since only
  // DATETIME values ever arrive as ISO timestamps needing this treatment.
  const formatDimensionValue = (v: string): string => {
    if (dimensionPropDef?.dataType !== "DATETIME") return v;
    const gran = config.dimensionDateGranularity || "none";
    return gran === "week" ? formatCompactWeekRange(v, timezone) : formatCompactDate(v, gran, timezone);
  };
```

(Note: `dimensionPropDef`/`dimensionSortType` already exist in the file from earlier work this session — only the new `formatDimensionValue` block is being added here, directly below them.)

- [ ] **Step 2: Wire it into the pie-mode legend list and the Pie/Bar tooltips**

Replace:

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
                          <Tooltip
                            contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                            formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                          />
                        </RePieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {sortedData.map((d: any, i: number) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                            <span className="flex-1 truncate text-foreground">{d.dimension == null ? "null" : formatDimensionValue(String(d.dimension))}</span>
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
                        <XAxis dataKey="dimension" tickFormatter={(v: any) => formatDimensionValue(String(v))} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                        <Tooltip
                          contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(v: any) => formatDimensionValue(String(v))}
                        />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {sortedData.map((_: any, i: number) => <Cell key={i} fill={DIMENSION_COLORS[i % DIMENSION_COLORS.length]} />)}
                        </Bar>
                      </ReBarChart>
                    </ResponsiveContainer>
                  )}
```

- [ ] **Step 3: Wire it into the results table's Dimension column**

Replace:

```tsx
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
```

with:

```tsx
                  {
                    key: "dimension", label: t.dimension, sortable: true, sortType: dimensionSortType, render: (d: any) => {
                      const i = sortedData.indexOf(d);
                      return (
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: DIMENSION_COLORS[i % DIMENSION_COLORS.length] }} />
                          {d.dimension == null ? "null" : formatDimensionValue(String(d.dimension))}
                        </span>
                      );
                    },
                  },
```

- [ ] **Step 4: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors.

- [ ] **Step 5: Commit**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "feat: format DATETIME dimension values in User/Content mode's chart and table"
```

---

### Task 4: Wire `formatDimensionValue` into Event mode's chart + table

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`

**Interfaces:**
- Consumes: `formatDimensionValue` (Task 3, defined once in this same component).
- Produces: no new exports — this completes the DATETIME-dimension-value formatting rollout across both render blocks.

- [ ] **Step 1: Add `formatter` to both Legends and both Tooltips in the Event results chart**

Replace:

```tsx
                <ResponsiveContainer width="100%" height={320}>
                  {chartType === "bar" ? (
                    <ReBarChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} labelFormatter={formatPeriod} />
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
                            return (
                              <Line
                                key={dim}
                                type="linear"
                                dataKey={dim}
                                stroke={color}
                                strokeWidth={2}
                                dot={{ r: 3, fill: "#fff", stroke: color, strokeWidth: 2 }}
                                activeDot={{ r: 5, fill: "#fff", stroke: color, strokeWidth: 2 }}
                              />
                            );
                          })}
                        </>
                      ) : (
                        <Line
                          type="linear"
                          dataKey="value"
                          stroke="var(--color-primary)"
                          strokeWidth={2.5}
                          dot={{ r: 3, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                        />
                      )}
                    </ReLineChart>
                  )}
                </ResponsiveContainer>
```

with:

```tsx
                <ResponsiveContainer width="100%" height={320}>
                  {chartType === "bar" ? (
                    <ReBarChart data={eventData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                      <XAxis dataKey="period" tickFormatter={formatPeriod} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                        labelFormatter={formatPeriod}
                        formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                      />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => formatDimensionValue(value)} />
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
                      <Tooltip
                        contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                        labelFormatter={formatPeriod}
                        formatter={(value: any, name: any) => [value, formatDimensionValue(String(name))]}
                      />
                      {hasDimension ? (
                        <>
                          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value: string) => formatDimensionValue(value)} />
                          {sortedDimensions.map((dim, i) => {
                            const color = DIMENSION_COLORS[i % DIMENSION_COLORS.length];
                            return (
                              <Line
                                key={dim}
                                type="linear"
                                dataKey={dim}
                                stroke={color}
                                strokeWidth={2}
                                dot={{ r: 3, fill: "#fff", stroke: color, strokeWidth: 2 }}
                                activeDot={{ r: 5, fill: "#fff", stroke: color, strokeWidth: 2 }}
                              />
                            );
                          })}
                        </>
                      ) : (
                        <Line
                          type="linear"
                          dataKey="value"
                          stroke="var(--color-primary)"
                          strokeWidth={2.5}
                          dot={{ r: 3, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: "#fff", stroke: "var(--color-primary)", strokeWidth: 2 }}
                        />
                      )}
                    </ReLineChart>
                  )}
                </ResponsiveContainer>
```

- [ ] **Step 2: Wire it into the flattened results table's Dimension column**

Replace:

```tsx
                { key: "period", label: t.period, sortable: true, sortType: "date" as const, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                ...(hasDimension ? [{ key: "dimension", label: t.dimension, sortable: true, sortType: dimensionSortType, render: (d: any) => String(d.dimension ?? "—") }] : []),
```

with:

```tsx
                { key: "period", label: t.period, sortable: true, sortType: "date" as const, render: (d: any) => <span className="text-muted-foreground">{formatPeriod(d.period)}</span> },
                ...(hasDimension ? [{ key: "dimension", label: t.dimension, sortable: true, sortType: dimensionSortType, render: (d: any) => d.dimension == null ? "—" : formatDimensionValue(String(d.dimension)) }] : []),
```

- [ ] **Step 3: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: same pre-existing baseline, no new errors.

- [ ] **Step 4: Commit**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "feat: format DATETIME dimension values in Event mode's chart legend, tooltip, and table"
```

---

### Task 5: Manual verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Push and deploy**

Push the accumulated commits from Tasks 1-4 to `main`. If GitHub Actions' `deploy-dev.yml` run fails with a zero-executed-steps signature (a known transient infra issue hit earlier this session), deploy directly instead:

```bash
git push origin main
gh run list --workflow=deploy-dev.yml --limit=1
```

If the run fails with zero steps executed on any job, fall back to a direct deploy (safe here since this task touches no container code):

```bash
cd analytics && npm run deploy:dev -- --containers-rollout=none
```

(If Docker/OrbStack isn't running locally, `npm run deploy:dev`'s `vite build && wrangler deploy` will fail at the container-image-build step with a clear "Docker CLI... could not be launched" error before any deploy happens — in that case run `wrangler deploy --env dev --containers-rollout=none` directly from `analytics/` instead, after `vite build --mode development` has already produced `analytics/dist`.)

- [ ] **Step 2: Verify a DATETIME dimension's values render in the new compact format**

On `https://analytics-dev.uni-scrm.com/analytics`, open a Content Analytics report grouped by "Posted at" (`source_created_at`). For each of the 6 granularities (不汇总/小时/天/周/月/季度), confirm:
- The pie/bar legend text, the results table's Dimension column, and (for the bar-chart view) the X-axis tick labels and tooltip all show the new compact format — no raw ISO strings, no locale month abbreviations like "Jun".
- `month` and `quarter` granularities always show a 2-digit year (e.g. `26/6`, `26/Q2`).
- `week` granularity shows a compressed range (`M/D-D` same month, `M/D-M/D` crossing months).

- [ ] **Step 3: Verify Event mode's DATETIME dimension formatting**

If reachable with real data (no event type currently exposes a DATETIME `eventProp` in production metadata, per this session's earlier work — this step may need a manually-crafted report via the `/api/reports` endpoint the way Task 7 of the prior DATETIME-dimension-granularity plan did), confirm the Event chart's legend, tooltip, and flattened table's Dimension column all use the same compact format as User/Content mode.

- [ ] **Step 4: Verify `formatPeriod`'s existing granularities are unaffected in substance, only in locale-independence**

Open any existing Event or Interval Analysis report. Confirm the Period column/x-axis:
- No longer shows a locale month abbreviation ("Jun 4" becomes "6/4").
- `week` granularity's range still compresses the same way it did before (now `6/8-14` instead of "Jun 8-14").
- `weekday` granularity (if any existing report uses it) is completely unchanged — still shows the pre-existing raw digit, confirming this fix didn't touch that path.

- [ ] **Step 5: Verify a past-year value shows the year prefix**

If a report's data includes an entry from a year before the current one (or can be tested by temporarily pointing a report's time range far enough back), confirm that entry shows a `yy/` prefix while same-year entries in the same report do not.

- [ ] **Step 6: Report results**

Summarize pass/fail for Steps 2-5, including any screenshots or network-request evidence gathered.
