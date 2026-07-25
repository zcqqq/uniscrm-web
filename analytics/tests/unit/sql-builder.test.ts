import { describe, it, expect } from "vitest";
import { buildSQL, buildSnapshotSQL, buildDimensionRangeSQL } from "../../src/index";

describe("buildSnapshotSQL", () => {
  it("builds a plain count query with no dimension", () => {
    const sql = buildSnapshotSQL("uniscrm.user", { measure: "count" }, "1");
    expect(sql).toContain("SELECT COUNT(DISTINCT id) as value");
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

  it("applies filter clauses", () => {
    const sql = buildSnapshotSQL(
      "uniscrm.content",
      { measure: "count", filters: [{ field: "content_type", operator: "=", value: "TWEET" }] },
      "1"
    );
    expect(sql).toContain("AND content_type = 'TWEET'");
  });
});

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

describe("buildSQL interval filters", () => {
  it("applies a filter only on the eventTypeA leg, after next_type is narrowed", () => {
    const sql = buildSQL(
      "interval",
      {
        event_type_a: "follow.follow", event_type_b: "dm.received",
        filters: [{ field: "followers_count", operator: ">", value: "100" }],
      },
      "1"
    );
    expect(sql).toContain("WHERE event_type = 'follow.follow' AND next_type = 'dm.received' AND followers_count > 100");
    // the base CTE (which still contains B-leg rows) must stay filter-free,
    // otherwise B-leg rows lacking the A-only prop would be dropped and break LEAD pairing
    expect(sql.split("next_time\n  FROM uniscrm.event")[1].split(")")[0]).not.toContain("followers_count");
  });

  it("has value / no value / between operators behave the same as other modes", () => {
    const hasValue = buildSQL("interval", { event_type_a: "a", event_type_b: "b", filters: [{ field: "x", operator: "has value", value: "" }] }, "1");
    expect(hasValue).toContain("AND x IS NOT NULL");

    const between = buildSQL("interval", { event_type_a: "a", event_type_b: "b", filters: [{ field: "x", operator: "between", value: "1", value2: "9" }] }, "1");
    expect(between).toContain("AND x BETWEEN 1 AND 9");
  });

  it("omits filter clauses entirely when none are provided (regression check)", () => {
    const sql = buildSQL("interval", { event_type_a: "a", event_type_b: "b" }, "1");
    expect(sql.trim().endsWith("next_type = 'b'")).toBe(true);
  });
});

// R2 Pipelines deliver at-least-once, so the same worker-generated row id can land in the
// Iceberg table more than once (observed on uniscrm.event). Unlike user/content, the event
// table has no compaction pass, so COUNT(*) silently over-counts. Every row-counting
// aggregate must count distinct ids instead.
describe("buildSQL at-least-once duplicate safety", () => {
  it("counts distinct event ids in total mode", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "count", granularity: "total" }, "1");
    expect(sql).toContain("COUNT(DISTINCT id) as value");
    expect(sql).not.toContain("COUNT(*)");
  });

  it("counts distinct event ids in time-grouped mode", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "count", granularity: "day" }, "1");
    expect(sql).toContain("COUNT(DISTINCT id) as value");
    expect(sql).not.toContain("COUNT(*)");
  });

  it("uses distinct event ids as the numerator of the per-user average", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "avg", granularity: "day" }, "1");
    expect(sql).toContain("COUNT(DISTINCT id) as total");
    expect(sql).toContain("COUNT(DISTINCT user_id) as users");
    expect(sql).not.toContain("COUNT(*)");
  });

  it("uses distinct ids for the total-mode per-user average", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "avg", granularity: "total" }, "1");
    expect(sql).toContain("CAST(COUNT(DISTINCT id) AS DOUBLE) / NULLIF(COUNT(DISTINCT user_id), 0)");
    expect(sql).not.toContain("COUNT(*)");
  });

  it("counts distinct ids in snapshot (user/content) mode", () => {
    expect(buildSnapshotSQL("uniscrm.user", { measure: "count" }, "1")).toContain("COUNT(DISTINCT id) as value");
    expect(buildSnapshotSQL("uniscrm.content", { measure: "count" }, "1")).not.toContain("COUNT(*)");
  });

  it("leaves the unique-users measure alone — already duplicate-safe", () => {
    const sql = buildSQL("event", { event_type: "follow.follow", measure: "users", granularity: "day" }, "1");
    expect(sql).toContain("COUNT(DISTINCT user_id) as value");
  });

  it("keeps COUNT(*) in funnel steps, which count rows of a user_id-grouped CTE", () => {
    // Each stepN CTE is `GROUP BY user_id`, so its rows are already one-per-user —
    // base-table duplicates cannot inflate it, and COUNT(DISTINCT) would be noise.
    const sql = buildSQL("funnel", { steps: ["a", "b"], window_value: 7, window_unit: "day" }, "1");
    expect(sql).toContain("COUNT(*) as count FROM step1");
    expect(sql).toContain("COUNT(*) as count FROM step2");
  });
});

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
