import { describe, it, expect } from "vitest";
import { buildSegmentQuery } from "../src/services/sql-builder";
import { getAllFields } from "../src/fields";

const fields = getAllFields();

describe("buildSegmentQuery", () => {
  it("targets the R2 tables and always filters by tenant", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields,
      7
    );
    expect(sql).toContain("uniscrm.user");
    expect(sql).toContain("tenant_id = 7");
    expect(sql).not.toContain("profile");
  });

  it("joins uniscrm.event only when a condition needs it", () => {
    const noEvent = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "name", operator: "=", value: "Ann" }] },
      fields, 7
    ).sql;
    expect(noEvent).not.toContain("uniscrm.event");
  });

  it("escapes string values instead of interpolating them raw", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "name", operator: "=", value: "o'brien" }] },
      fields, 7
    );
    expect(sql).toContain("'o''brien'");
  });

  it("reads followers_count as a real column now that R2 has one", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields, 7
    );
    expect(sql).not.toContain("json_extract");
  });
});
