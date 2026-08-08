import { describe, it, expect } from "vitest";
import { getAllFields, SEGMENT_USER_COLUMNS } from "../src/fields";
import { buildSegmentQuery } from "../src/services/sql-builder";

// 快照对账：SQL_EXPR_MAP / USER_DEDUP_COLUMNS 在 2026-08-08 之前是手写字面量，现在从
// metadata/columns.ts（经 fields.ts 的 SEGMENT_USER_PROP_IDS 产品清单）推导。这里冻结
// 旧字面量并断言推导结果逐字相同 —— 包括顺序：USER_DEDUP_COLUMNS 直接进入生成的 SQL 文本。
const FROZEN_SEGMENT_USER_COLUMNS = [
  "name", "username", "followers_count", "following_count",
  "verified_type", "is_follow", "is_followed",
];

const FROZEN_USER_DEDUP_COLUMNS = [
  "id", "channel_id", "source_user_id", "name", "username",
  "followers_count", "following_count", "verified_type", "is_follow", "is_followed",
  "is_deleted", "updated_at",
];

describe("insight-segment column derivation matches the pre-refactor literals", () => {
  it("SEGMENT_USER_COLUMNS — exact array", () => {
    expect(SEGMENT_USER_COLUMNS).toEqual(FROZEN_SEGMENT_USER_COLUMNS);
  });

  it("SQL_EXPR_MAP (via getAllFields) — same user fields with the same u.<column> exprs", () => {
    const userFields = getAllFields("en").filter((f) => f.source === "user");
    expect(userFields.map((f) => [f.propId, f.sqlExpr]).sort()).toEqual(
      FROZEN_SEGMENT_USER_COLUMNS.map((c) => [c, `u.${c}`]).sort()
    );
  });

  it("USER_DEDUP_COLUMNS (via generated SQL) — byte-identical projection, same order", () => {
    // Single-line `SELECT ... FROM` is latestRowsSql's inner-query shape (buildSegmentQuery
    // composes through shared/r2-sql.ts since Batch F); the frozen column list is unchanged.
    const { sql } = buildSegmentQuery({ logic: "AND", conditions: [] }, getAllFields("en"), 7);
    expect(sql).toContain(`SELECT ${FROZEN_USER_DEDUP_COLUMNS.join(", ")} FROM uniscrm.user`);
  });
});
