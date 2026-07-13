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
