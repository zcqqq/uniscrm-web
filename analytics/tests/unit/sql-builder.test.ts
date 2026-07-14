import { describe, it, expect } from "vitest";
import { buildSQL, buildSnapshotSQL } from "../../src/index";

describe("buildSnapshotSQL", () => {
  it("builds a plain count query with no dimension", () => {
    const sql = buildSnapshotSQL("uniscrm.user", { measure: "count" }, "1");
    expect(sql).toContain("SELECT COUNT(*) as value");
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
