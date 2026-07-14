# INT Dimension Bucketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For any INT-dataType dimension (User/Content Analytics and Event Analysis alike), let the user pick between three grouping modes — discrete (raw value), default (auto 10-bucket equal-width), custom (user-defined chained interval boundaries) — via a `⚙️配置` popover, matching the researched `cdp.linkflowtech.com` reference UI.

**Architecture:** Backend: a shared `buildDimensionBucketing()` helper generates the CASE-WHEN dimension expression for all three modes (discrete/custom unchanged from today's logic; default is new — a `WITH bounds AS (SELECT MIN/MAX ...)` CTE cross-joined into the query, with 10 equal-width CASE branches computed via SQL arithmetic against the bounds), used by both `buildSnapshotSQL` (User/Content) and the `"event"` branch of `buildSQL`. Frontend: `SelectProps` is generalized to take an `options` list (retiring its `eventType`-based internal lookup) so it can be reused by both User/Content mode's dimension `<Select>` and Event mode's existing usage; a new `BucketModePopover` component (3-radio group + chained interval-row editor) replaces the current flat comma-separated bucket `Input`, wired into `ReportConfig.tsx` for every mode where a selected dimension's `dataType === "INT"`.

**Tech Stack:** TypeScript, Cloudflare Workers (Hono), React, Vitest.

## Global Constraints

- Any dimension whose `PropDefinition.dataType === "INT"` gets the bucketing UI — detected via a global `PROPS_X` lookup, not the entity-scoped one User/Content mode currently uses (spec §Scope).
- `dimensionBucketMode` values are exactly `"discrete" | "default" | "custom"`; unset/legacy reports infer `"custom"` if `buckets` is non-empty, else `"discrete"` (spec §1).
- Default mode is a fixed 10 equal-width buckets computed from the dimension's actual min/max, scoped to the same tenant/filter conditions as the rest of the query (spec §1, §3).
- Keep the `SelectProps` name (not renamed) per explicit preference — easy to find via search (spec §2).
- No new frontend test infrastructure: this repo has no `@testing-library`/jsdom setup for React components anywhere, so this plan does not introduce one — test coverage for this feature lives in the backend SQL-generation unit tests (`analytics/tests/unit/sql-builder.test.ts`), consistent with this module's existing test coverage pattern.

---

## File Structure

- **Modify** `analytics/src/index.ts` — add `buildDimensionBucketing()` helper; wire it into `buildSnapshotSQL` and the `"event"` branch of `buildSQL`.
- **Modify** `analytics/tests/unit/sql-builder.test.ts` — add tests for the new helper and the two call sites' new `"default"`/`"custom"`-in-event-mode behavior.
- **Modify** `shared/frontend/components/SelectProps.tsx` — generalize to `{ options: PropDefinition[], value, onChange, locale, placeholder }`, built on the shared shadcn `Select`.
- **Create** `shared/frontend/components/BucketModePopover.tsx` — the `⚙️配置` popover (3 radios + chained interval editor).
- **Modify** `analytics/frontend/components/ReportConfig.tsx` — use the generalized `SelectProps` for User/Content mode's dimension picker too; replace the flat bucket `Input` with `BucketModePopover`, shown for any INT dimension in any non-funnel/non-interval mode.
- **Modify** `analytics/frontend/pages/AnalyticsDetail.tsx` — thread `dimensionBucketMode` through `buildReportParams` and the saved-report-restore effect.

---

### Task 1: buildDimensionBucketing helper + default mode for buildSnapshotSQL

**Files:**
- Modify: `analytics/src/index.ts`
- Test: `analytics/tests/unit/sql-builder.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `function buildDimensionBucketing(params: { dimension: string; mode?: "discrete" | "default" | "custom"; buckets?: number[]; fromTable: string; tenantId: string; scopeFilter: string }): { dimExpr: string; dimGroupCol: string; boundsCte: string; fromExtra: string }` — consumed by Task 2's event-branch changes.

- [ ] **Step 1: Write the failing tests**

Add to `analytics/tests/unit/sql-builder.test.ts`, inside the existing `describe("buildSnapshotSQL", ...)` block (after the `"groups by numeric buckets when provided"` test, before `"applies filter clauses"`):

```ts
  it("groups by a default 10-bucket equal-width split when mode is default", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "like_count", dimension_bucket_mode: "default" },
      "1"
    );
    expect(sql).toContain("WITH bounds AS (SELECT MIN(like_count) as mn, MAX(like_count) as mx FROM uniscrm.content WHERE tenant_id = 1 )");
    expect(sql).toContain("FROM uniscrm.content, bounds");
    expect(sql).toContain("WHEN like_count < (bounds.mn + (bounds.mx - bounds.mn) * 1 / 10) THEN");
    expect(sql).toContain("ELSE CAST(CAST((bounds.mn + (bounds.mx - bounds.mn) * 9 / 10) AS BIGINT) AS VARCHAR) || '+'");
    expect(sql).toContain("GROUP BY dimension ORDER BY dimension");
  });

  it("default mode's bounds CTE includes the same filter clauses as the outer query", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      {
        measure: "count", dimension: "like_count", dimension_bucket_mode: "default",
        filters: [{ field: "content_type", operator: "=", value: "TWEET" }],
      },
      "1"
    );
    expect(sql).toContain("WITH bounds AS (SELECT MIN(like_count) as mn, MAX(like_count) as mx FROM uniscrm.content WHERE tenant_id = 1 AND content_type = 'TWEET')");
  });

  it("default mode takes priority over a stale buckets array", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", dimension: "like_count", dimension_bucket_mode: "default", buckets: [100, 1000] },
      "1"
    );
    expect(sql).toContain("WITH bounds AS");
    expect(sql).not.toContain("WHEN like_count < 100 THEN");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: the 3 new tests FAIL (no `dimension_bucket_mode` handling exists yet); all pre-existing tests still PASS.

- [ ] **Step 3: Implement buildDimensionBucketing and wire it into buildSnapshotSQL**

In `analytics/src/index.ts`, add this new function immediately before `export function buildSnapshotSQL`:

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

  if (mode === "default") {
    const boundsCte = `WITH bounds AS (SELECT MIN(${dimension}) as mn, MAX(${dimension}) as mx FROM ${fromTable} WHERE tenant_id = ${tenantId} ${scopeFilter}) `;
    const edge = (i: number) => `(bounds.mn + (bounds.mx - bounds.mn) * ${i} / 10)`;
    const cases: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const lowEdge = i === 1 ? "bounds.mn" : edge(i - 1);
      cases.push(`WHEN ${dimension} < ${edge(i)} THEN CAST(CAST(${lowEdge} AS BIGINT) AS VARCHAR) || '-' || CAST(CAST(${edge(i)} AS BIGINT) AS VARCHAR)`);
    }
    cases.push(`ELSE CAST(CAST(${edge(9)} AS BIGINT) AS VARCHAR) || '+'`);
    return {
      dimExpr: `, CASE ${cases.join(" ")} END as dimension`,
      dimGroupCol: "dimension",
      boundsCte,
      fromExtra: ", bounds",
    };
  }

  if (buckets && buckets.length > 0) {
    const cases = buckets.map((b, i) => {
      const prev = i === 0 ? 0 : buckets[i - 1];
      return `WHEN ${dimension} < ${b} THEN '${prev}-${b}'`;
    });
    cases.push(`ELSE '${buckets[buckets.length - 1]}+'`);
    return {
      dimExpr: `, CASE ${cases.join(" ")} END as dimension`,
      dimGroupCol: "dimension",
      boundsCte: "",
      fromExtra: "",
    };
  }

  return {
    dimExpr: `, ${dimension} as dimension`,
    dimGroupCol: dimension,
    boundsCte: "",
    fromExtra: "",
  };
}
```

Then change `buildSnapshotSQL` from:

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

to:

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

  const agg = measure === "avg" && measure_field ? `AVG(CAST(${measure_field} AS DOUBLE))`
    : measure === "sum" && measure_field ? `SUM(CAST(${measure_field} AS DOUBLE))`
    : "COUNT(*)";

  return `${boundsCte}SELECT ${agg} as value${dimExpr}
FROM ${tableName}${fromExtra}
WHERE tenant_id = ${tenantId} ${filterClauses}${dimGroup}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: all tests PASS (the 3 new ones, plus all pre-existing `buildSnapshotSQL`/`buildSQL` tests unchanged).

- [ ] **Step 5: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no new errors (this module has ~150 pre-existing unrelated errors from missing root `@types/react` — confirm nothing new references `index.ts`).

- [ ] **Step 6: Commit**

```bash
git add analytics/src/index.ts analytics/tests/unit/sql-builder.test.ts
git commit -m "Add buildDimensionBucketing helper; wire default-mode bucketing into buildSnapshotSQL"
```

---

### Task 2: Extend the event branch with custom + default bucket modes

**Files:**
- Modify: `analytics/src/index.ts`
- Test: `analytics/tests/unit/sql-builder.test.ts`

**Interfaces:**
- Consumes: `buildDimensionBucketing` from Task 1 (exact signature above).
- Produces: no new exports — `buildSQL`'s `"event"` branch behavior extended, still reached via the existing `buildSQL(type, params, tenantId)` export.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `analytics/tests/unit/sql-builder.test.ts` (after the existing `describe("buildSQL", ...)` block):

```ts
describe("buildSQL event dimension bucketing", () => {
  it("still groups by the raw dimension column when no bucket mode is set (regression check)", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "count", dimension: "followers_count", granularity: "day" }, "1");
    expect(sql).toContain(", followers_count as dimension");
    expect(sql).toContain("GROUP BY period, followers_count ORDER BY period");
  });

  it("applies custom buckets to the event dimension", () => {
    const sql = buildSQL(
      "event",
      { event_type: "follow.follow", measure: "count", dimension: "followers_count", granularity: "day", buckets: [100, 1000] },
      "1"
    );
    expect(sql).toContain("WHEN followers_count < 100 THEN '0-100'");
    expect(sql).toContain("GROUP BY period, dimension ORDER BY period");
  });

  it("applies default 10-bucket equal-width split to the event dimension", () => {
    const sql = buildSQL(
      "event",
      { event_type: "follow.follow", measure: "count", dimension: "followers_count", granularity: "day", dimension_bucket_mode: "default" },
      "1"
    );
    expect(sql).toContain("WITH bounds AS (SELECT MIN(followers_count) as mn, MAX(followers_count) as mx FROM uniscrm.event WHERE tenant_id = 1 AND event_type = 'follow.follow'");
    expect(sql).toContain("FROM uniscrm.event, bounds");
    expect(sql).toContain("GROUP BY period, dimension ORDER BY period");
  });

  it("applies default bucketing in total (no time-grouping) mode", () => {
    const sql = buildSQL(
      "event",
      { event_type: "follow.follow", measure: "count", dimension: "followers_count", granularity: "total", dimension_bucket_mode: "default" },
      "1"
    );
    expect(sql).toContain("WITH bounds AS");
    expect(sql).toContain("SELECT 'total' as period, CASE");
    expect(sql).toContain("GROUP BY dimension");
  });

  it("applies default bucketing in avg-measure mode", () => {
    const sql = buildSQL(
      "event",
      { event_type: "follow.follow", measure: "avg", dimension: "followers_count", granularity: "day", dimension_bucket_mode: "default" },
      "1"
    );
    expect(sql).toContain("WITH bounds AS");
    expect(sql).toContain("GROUP BY period, dimension");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: the 4 new tests requiring bucket support FAIL (custom/default bucketing not wired into the event branch yet); the regression-check test PASSES already (today's discrete behavior is unchanged).

- [ ] **Step 3: Wire buildDimensionBucketing into the event branch**

In `analytics/src/index.ts`, change the `"event"` branch of `buildSQL` from:

```ts
  if (type === "event") {
    const { event_type, measure, dimension, granularity, time_range_start, time_range_end, filters } = params as {
      event_type: string; measure: string; dimension?: string; granularity?: string;
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };
    const gran = granularity || "day";

    const timeFilter = [
      time_range_start ? `AND event_time >= '${time_range_start}'` : "",
      time_range_end ? `AND event_time <= '${time_range_end}'` : "",
    ].join(" ");

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    const dimCol = dimension ? `, ${dimension} as dimension` : "";
    const dimGroup = dimension ? `, ${dimension}` : "";

    // Total (aggregate) mode — no time grouping
    if (gran === "total") {
      const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : measure === "avg" ? "CAST(COUNT(*) AS DOUBLE) / NULLIF(COUNT(DISTINCT user_id), 0)" : "COUNT(*)";
      return `SELECT 'total' as period${dimCol}, ${agg} as value
FROM uniscrm.event
WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}${dimGroup ? ` GROUP BY ${dimension}` : ""}`;
    }

    const periodExpr = gran === "month" ? "DATE_TRUNC('month', event_time)"
      : gran === "week" ? "DATE_TRUNC('week', event_time)"
      : gran === "hour" ? "EXTRACT(HOUR FROM event_time)"
      : gran === "weekday" ? "EXTRACT(DOW FROM event_time)"
      : "DATE_TRUNC('day', event_time)";

    if (measure === "avg") {
      return `SELECT period${dimCol ? ", dimension" : ""}, CAST(total AS DOUBLE) / NULLIF(users, 0) as value FROM (
  SELECT ${periodExpr} as period${dimCol}, COUNT(*) as total, COUNT(DISTINCT user_id) as users
  FROM uniscrm.event
  WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}
  GROUP BY period${dimGroup}
) ORDER BY period`;
    }

    const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : "COUNT(*)";
    return `SELECT ${periodExpr} as period${dimCol}, ${agg} as value
FROM uniscrm.event
WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}
GROUP BY period${dimGroup} ORDER BY period`;
  }
```

to:

```ts
  if (type === "event") {
    const { event_type, measure, dimension, granularity, dimension_bucket_mode, buckets, time_range_start, time_range_end, filters } = params as {
      event_type: string; measure: string; dimension?: string; granularity?: string;
      dimension_bucket_mode?: "discrete" | "default" | "custom"; buckets?: number[];
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };
    const gran = granularity || "day";

    const timeFilter = [
      time_range_start ? `AND event_time >= '${time_range_start}'` : "",
      time_range_end ? `AND event_time <= '${time_range_end}'` : "",
    ].join(" ");

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    const eventScopeFilter = `AND event_type = '${event_type}' ${timeFilter} ${filterClauses}`;

    let dimCol = "";
    let dimGroupCol = "";
    let boundsCte = "";
    let fromExtra = "";
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

    // Total (aggregate) mode — no time grouping
    if (gran === "total") {
      const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : measure === "avg" ? "CAST(COUNT(*) AS DOUBLE) / NULLIF(COUNT(DISTINCT user_id), 0)" : "COUNT(*)";
      return `${boundsCte}SELECT 'total' as period${dimCol}, ${agg} as value
FROM uniscrm.event${fromExtra}
WHERE tenant_id = ${tenantId} ${eventScopeFilter}${dimGroupCol ? ` GROUP BY ${dimGroupCol}` : ""}`;
    }

    const periodExpr = gran === "month" ? "DATE_TRUNC('month', event_time)"
      : gran === "week" ? "DATE_TRUNC('week', event_time)"
      : gran === "hour" ? "EXTRACT(HOUR FROM event_time)"
      : gran === "weekday" ? "EXTRACT(DOW FROM event_time)"
      : "DATE_TRUNC('day', event_time)";

    if (measure === "avg") {
      return `${boundsCte}SELECT period${dimCol ? ", dimension" : ""}, CAST(total AS DOUBLE) / NULLIF(users, 0) as value FROM (
  SELECT ${periodExpr} as period${dimCol}, COUNT(*) as total, COUNT(DISTINCT user_id) as users
  FROM uniscrm.event${fromExtra}
  WHERE tenant_id = ${tenantId} ${eventScopeFilter}
  GROUP BY period${dimGroupCol ? `, ${dimGroupCol}` : ""}
) ORDER BY period`;
    }

    const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : "COUNT(*)";
    return `${boundsCte}SELECT ${periodExpr} as period${dimCol}, ${agg} as value
FROM uniscrm.event${fromExtra}
WHERE tenant_id = ${tenantId} ${eventScopeFilter}
GROUP BY period${dimGroupCol ? `, ${dimGroupCol}` : ""} ORDER BY period`;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analytics && npx vitest run tests/unit/sql-builder.test.ts`
Expected: all tests PASS, including the regression-check test (discrete behavior byte-for-byte unchanged) and the 4 new bucket-mode tests.

- [ ] **Step 5: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add analytics/src/index.ts analytics/tests/unit/sql-builder.test.ts
git commit -m "Extend event branch's dimension grouping with custom/default bucket modes"
```

---

### Task 3: Generalize SelectProps to take an options list

**Files:**
- Modify: `shared/frontend/components/SelectProps.tsx`
- Modify: `analytics/frontend/components/ReportConfig.tsx`

**Interfaces:**
- Consumes: `PropDefinition` type from `metadata/dataTypes.ts` (already exported: `propId: string; dataType: PropDataType; label: LocalizedString; ...`).
- Produces: `SelectProps({ options: PropDefinition[], value: string, onChange: (propId: string) => void, locale?: Locale, placeholder?: string })` — consumed by Task 4's `ReportConfig.tsx` changes (User/Content mode's dimension picker switches to this too).

- [ ] **Step 1: Rewrite SelectProps**

Change `shared/frontend/components/SelectProps.tsx` from:

```tsx
import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
import { t, type Locale } from "../../../metadata/locale";

interface SelectPropsProps {
  eventType: string;
  value: string;
  onChange: (propId: string) => void;
  locale?: Locale;
  placeholder?: string;
}

export function SelectProps({ eventType, value, onChange, locale = "en", placeholder }: SelectPropsProps) {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  const eventPropIds = meta?.eventProps.map((p) => p.propId) || [];
  const options = eventPropIds
    .map((id) => PROPS_X.find((p) => p.propId === id))
    .filter(Boolean)
    .map((p) => ({ id: p!.propId, label: t(p!.label, locale) }));

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-border rounded px-2 py-1.5 text-sm"
    >
      <option value="">{placeholder || (locale === "zh" ? "不分组" : "No grouping")}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}
```

to:

```tsx
import type { PropDefinition } from "../../../metadata/dataTypes";
import { t, type Locale } from "../../../metadata/locale";
import { Select } from "../ui/select";

interface SelectPropsProps {
  options: PropDefinition[];
  value: string;
  onChange: (propId: string) => void;
  locale?: Locale;
  placeholder?: string;
}

export function SelectProps({ options, value, onChange, locale = "en", placeholder }: SelectPropsProps) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder || (locale === "zh" ? "不分组" : "No grouping")}</option>
      {options.map((p) => (
        <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>
      ))}
    </Select>
  );
}
```

- [ ] **Step 2: Update ReportConfig.tsx's call sites**

In `analytics/frontend/components/ReportConfig.tsx`, add an import for the `PropDefinition` type alongside the existing metadata import — change:

```ts
import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
```

to:

```ts
import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
import type { PropDefinition } from "../../../metadata/dataTypes";
```

Then add a helper right after the existing `propsByEntity` function (around line 15):

```ts
const eventPropsFor = (eventType: string): PropDefinition[] => {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  const eventPropIds = meta?.eventProps.map((p) => p.propId) || [];
  return eventPropIds.map((id) => PROPS_X.find((p) => p.propId === id)).filter((p): p is PropDefinition => !!p);
};
```

Change the Event/Interval-mode dimension picker's `SelectProps` usage from:

```tsx
              ) : (
                <SelectProps
                  eventType={mode === "interval" ? (values.eventTypeA || "") : values.eventType}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              )}
```

to:

```tsx
              ) : (
                <SelectProps
                  options={eventPropsFor(mode === "interval" ? (values.eventTypeA || "") : values.eventType)}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              )}
```

Change the filter-condition row's `SelectProps` usage from:

```tsx
                <SelectProps
                  eventType={values.eventType}
                  value={f.field}
                  onChange={(v) => updateFilter(i, { field: v })}
                  locale={locale}
                  placeholder={locale === "zh" ? "选择属性" : "Select field"}
                />
```

to:

```tsx
                <SelectProps
                  options={eventPropsFor(values.eventType)}
                  value={f.field}
                  onChange={(v) => updateFilter(i, { field: v })}
                  locale={locale}
                  placeholder={locale === "zh" ? "选择属性" : "Select field"}
                />
```

Change the User/Content mode's inline `<Select>` dimension picker from:

```tsx
              {mode === "user" || mode === "content" ? (
                <Select value={values.dimension} onChange={(e) => update({ dimension: e.target.value, buckets: "" })}>
                  <option value="">{s.noGroup}</option>
                  {entityProps.map((p) => <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>)}
                </Select>
              ) : (
```

to:

```tsx
              {mode === "user" || mode === "content" ? (
                <SelectProps
                  options={entityProps}
                  value={values.dimension}
                  onChange={(v) => update({ dimension: v, buckets: "" })}
                  locale={locale}
                  placeholder={s.noGroup}
                />
              ) : (
```

- [ ] **Step 3: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no new errors. (`link`'s typecheck is unaffected — `SelectProps` is only imported by `analytics/frontend`; confirm with `grep -rn "SelectProps" --include="*.tsx" .` from repo root that no other module imports it.)

Run: `cd /Users/zc/Documents/UniSCRM/uniscrm-web && grep -rln "SelectProps" --include="*.tsx" . | grep -v node_modules`
Expected: only `shared/frontend/components/SelectProps.tsx` (definition) and `analytics/frontend/components/ReportConfig.tsx` (usage) — confirming no other module needs updating for this signature change.

- [ ] **Step 4: Commit**

```bash
git add shared/frontend/components/SelectProps.tsx analytics/frontend/components/ReportConfig.tsx
git commit -m "Generalize SelectProps to take an options list; use it for User/Content dimension picker too"
```

---

### Task 4: BucketModePopover component + wire into ReportConfig/AnalyticsDetail

**Files:**
- Create: `shared/frontend/components/BucketModePopover.tsx`
- Modify: `analytics/frontend/components/ReportConfig.tsx`
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`

**Interfaces:**
- Consumes: `SelectProps` from Task 3 (unaffected by this task); `Popover`/`PopoverTrigger`/`PopoverContent` from `shared/frontend/ui/popover.tsx` (already exists, unchanged).
- Produces: `ReportConfigValues.dimensionBucketMode?: "discrete" | "default" | "custom"` — consumed by `AnalyticsDetail.tsx`'s `buildReportParams` and its saved-report-restore effect (both in this same task).

- [ ] **Step 1: Create BucketModePopover**

Create `shared/frontend/components/BucketModePopover.tsx`:

```tsx
import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Locale } from "../../../metadata/locale";

export type BucketMode = "discrete" | "default" | "custom";

interface BucketModePopoverProps {
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

export function BucketModePopover({ mode, buckets, onChange, locale = "en" }: BucketModePopoverProps) {
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
    onChange({ mode: draftMode, buckets: draftMode === "custom" ? sorted.join(",") : buckets });
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

- [ ] **Step 2: Wire BucketModePopover into ReportConfig.tsx**

In `analytics/frontend/components/ReportConfig.tsx`, add the import near the top (with the other component imports):

```tsx
import { BucketModePopover, type BucketMode } from "../../../shared/frontend/components/BucketModePopover";
```

Add `dimensionBucketMode` to `ReportConfigValues` — change:

```ts
export interface ReportConfigValues {
  mode?: "event" | "interval" | "user" | "content" | "funnel";
  eventType: string;
  measure: "count" | "users" | "avg" | "sum";
  measureField?: string;
  eventTypeA?: string;
  eventTypeB?: string;
  dimension: string;
  buckets?: string;
```

to:

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
```

Add a global INT-dimension lookup near the top of the component (replacing the entity-scoped-only check used today), right after the existing `numericEntityProps` line:

```tsx
  const numericEntityProps = entityProps.filter((p) => p.dataType === "INT");
  const selectedDimensionIsInt = PROPS_X.find((p) => p.propId === values.dimension)?.dataType === "INT";
```

Replace the existing bucket-input block — change:

```tsx
            {values.dimension && entityProps.find(p => p.propId === values.dimension)?.dataType === "INT" && (
              <div className="mt-2">
                <Input
                  type="text"
                  value={values.buckets || ""}
                  onChange={(e) => update({ buckets: e.target.value })}
                  placeholder={locale === "zh" ? "分档边界 (逗号分隔, 如 100,1000,10000)" : "Bucket boundaries (comma-separated, e.g. 100,1000,10000)"}
                  className="text-xs h-7"
                />
              </div>
            )}
```

to:

```tsx
            {values.dimension && selectedDimensionIsInt && (
              <div className="mt-2">
                <BucketModePopover
                  mode={values.dimensionBucketMode || (values.buckets ? "custom" : "discrete")}
                  buckets={values.buckets || ""}
                  onChange={({ mode, buckets }) => update({ dimensionBucketMode: mode, buckets })}
                  locale={locale}
                />
              </div>
            )}
```

- [ ] **Step 3: Thread dimensionBucketMode through AnalyticsDetail.tsx**

In `analytics/frontend/pages/AnalyticsDetail.tsx`, change the saved-report-restore effect — from:

```ts
        dimension: p.dimension || "",
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
```

to:

```ts
        dimension: p.dimension || "",
        dimensionBucketMode: p.dimension_bucket_mode || (Array.isArray(p.buckets) && p.buckets.length > 0 ? "custom" : "discrete"),
        buckets: Array.isArray(p.buckets) ? p.buckets.join(",") : (p.buckets || ""),
```

Change `buildReportParams`'s User/Content branch — from:

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

to:

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

Change the final (Event mode) `return` block of `buildReportParams` — from:

```ts
    return {
      event_type: config.eventType,
      measure: config.measure,
      dimension: config.dimension || undefined,
      granularity: config.granularity,
      time_range: config.timeRange,
      time_range_start: start,
      compare_enabled: !!config.compareEnabled,
      compare_time_range: config.compareTimeRange || undefined,
      filters: config.filters,
      chart_type: chartType,
```

to:

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
```

(leave the line right after this block — `};`, closing the returned object — unchanged; only the lines shown above change.)

- [ ] **Step 4: Typecheck**

Run: `cd analytics && npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add shared/frontend/components/BucketModePopover.tsx analytics/frontend/components/ReportConfig.tsx analytics/frontend/pages/AnalyticsDetail.tsx
git commit -m "Add BucketModePopover; wire 3-way dimension bucket mode into ReportConfig and AnalyticsDetail"
```

---

### Task 5: Manual verification in dev

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite and typecheck**

Run: `cd analytics && npm test && npm run typecheck`
Expected: all tests pass (including Tasks 1-2's new tests); typecheck shows the same pre-existing baseline error count as before this plan (no new errors).

- [ ] **Step 2: Start the dev server and verify locally**

Run: `cd analytics && npm run dev`
Expected: Vite dev server starts. Open a User Analysis or Content Analysis report, pick an INT dimension (e.g. Likes/Followers), confirm the `⚙️ 配置` link appears; open it, confirm the 3 radio options and — when "使用自定义区间" is selected — the chained interval-row editor (first row `-∞`, last row `+∞`, boundaries auto-fill between adjacent rows, "+ 添加区间" adds a row). Repeat for an Event Analysis report's dimension picker.

- [ ] **Step 3: Verify against the real dev deployment**

After pushing (per this repo's CI convention — pushing to `main` auto-deploys dev), repeat Step 2's verification against the real `analytics-dev.uni-scrm.com` site: create a report with an INT dimension, try all 3 modes, confirm the computed range labels render sensibly for "默认区间" mode (e.g. distinct, ascending, non-overlapping labels) and that "使用离散数字" and "使用自定义区间" behave identically to today's pre-change behavior (discrete: unchanged; custom: same as the old flat comma input, just entered via the new editor).

- [ ] **Step 4: Report completion**

If any issue is found, fix it in the relevant task's files, re-run that task's tests/typecheck, and commit the fix before reporting the plan complete.

---

## Self-Review Notes

- **Spec coverage:** §1 data model → Task 4 Step 2-3 (`dimensionBucketMode` field + backward-compat inference). §2 frontend (SelectProps unification + BucketModePopover) → Tasks 3-4. §3 backend (buildDimensionBucketing, both call sites) → Tasks 1-2. §4 testing → Tasks 1-2's unit tests + Task 5's manual verification (frontend component tests explicitly out of scope per Global Constraints, since no test infra exists for them in this repo).
- **Type consistency:** `BucketMode` (`"discrete" | "default" | "custom"`) is defined once in `BucketModePopover.tsx` and imported by `ReportConfig.tsx`; `dimension_bucket_mode` (snake_case, wire format) vs `dimensionBucketMode` (camelCase, `ReportConfigValues` field) naming matches the existing convention in this file (e.g. `measure_field` vs `measureField`, `event_type_a` vs `eventTypeA`).
- **No placeholders:** every step shows exact before/after code or exact commands with expected output.
