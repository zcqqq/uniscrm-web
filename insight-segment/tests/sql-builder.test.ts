import { describe, it, expect } from "vitest";
import { buildSegmentQuery } from "../src/services/sql-builder";
import { getAllFields } from "../src/fields";

const fields = getAllFields();

// buildSegmentQuery's SQL has exactly two top-level "WHERE ..." clauses: the dedup subquery's
// (pre-QUALIFY, tenant_id only) and the outer one (post-QUALIFY, is_deleted + user/event
// conditions). Order in the returned array matches source order — [inner, outer].
function whereClauses(sql: string): string[] {
  return [...sql.matchAll(/WHERE ([^\n]+)/g)].map((m) => m[1]);
}

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

  // C2 regression guard: `uniscrm.user.id` (the deduped subquery's `u.id`) is entity_state's
  // minted uuid, while `uniscrm.event.user_id` is written from the external platform id (see
  // link/src/services/x-users.ts's buildEventRecord and webhook.ts:295) — the two are different
  // id domains (docs/adr/0005). Joining on `u.id` never matches a real event row, so every
  // event-conditioned segment silently resolves to zero users. The join must key on the SOURCE
  // identity instead: source_user_id + channel_id (source_user_id alone isn't unique across
  // channels). tenant_id must appear on the event side too, for R2 SQL's window-function budget
  // gate (see the sql-builder.ts comment above the join).
  it("joins uniscrm.event on the source identity (source_user_id + channel_id), never on u.id", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "event_type", operator: "=", value: "purchase" }] },
      fields, 7
    );
    expect(sql).toContain(
      "LEFT JOIN uniscrm.event e ON e.user_id = u.source_user_id AND e.channel_id = u.channel_id AND e.tenant_id = 7"
    );
    expect(sql).not.toContain("e.user_id = u.id");
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

  // Regression guard for the Task 4 row-resurrection bug (is_deleted filtered pre-QUALIFY drops
  // the true-latest row from the dedup window's input, letting a stale row win "= 1"), applied
  // here to buildSegmentQuery specifically since this module hand-writes its SQL instead of
  // going through shared/r2-sql.ts's latestRowsSql. An edit that moved is_deleted back into the
  // inner WHERE would pass every other test in this file untouched — see task-9-report.md's
  // fix-round-1 section for the mutation-test proof that this assertion actually has teeth.
  it("keeps the dedup subquery's WHERE limited to tenant_id, deferring is_deleted to the outer WHERE", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields, 7
    );
    const [innerWhere, outerWhere] = whereClauses(sql);
    expect(innerWhere).toBe("tenant_id = 7");
    expect(innerWhere).not.toContain("is_deleted");
    expect(outerWhere).toContain("is_deleted = 0");
  });

  it("also defers is_deleted to the outer WHERE, AND'd at the top level, when conditions are OR'd together", () => {
    // An is_deleted=0 clause folded into the OR group itself would let a deleted user through
    // the moment any other OR'd clause was true — a second, independent way the naive "flat
    // WHERE list" shape breaks under OR logic. is_deleted must stay outside the parenthesized
    // OR group: `WHERE u.is_deleted = 0 AND (...)`, never inside it.
    const { sql } = buildSegmentQuery(
      {
        logic: "OR",
        conditions: [
          { field: "followers_count", operator: ">", value: 100 },
          { field: "event_type", operator: "=", value: "purchase" },
        ],
      },
      fields, 7
    );
    const [innerWhere, outerWhere] = whereClauses(sql);
    expect(innerWhere).toBe("tenant_id = 7");
    expect(outerWhere).toMatch(/^u\.is_deleted = 0 AND \(/);
  });

  it("dedups on exactly (channel_id, source_user_id), latest updated_at wins", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields, 7
    );
    expect(sql).toMatch(
      /QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY channel_id, source_user_id ORDER BY updated_at DESC\) = 1/
    );
  });

  it("escapes every value in an IN list", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "name", operator: "IN", value: ["o'brien", "Ann"] }] },
      fields, 7
    );
    expect(sql).toContain("IN ('o''brien', 'Ann')");
  });

  it("escapes both endpoints of a BETWEEN", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: "BETWEEN", value: ["100", "200"] }] },
      fields, 7
    );
    expect(sql).toContain("BETWEEN 100 AND 200");
  });

  it("computes timeRelative as a quoted ISO literal, not raw SQL date arithmetic", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "event_time", operator: ">=", value: "", timeRelative: "7d" }] },
      fields, 7
    );
    expect(sql).toMatch(/e\.event_time >= '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'/);
    expect(sql).not.toContain("NOW()");
    expect(sql).not.toContain("INTERVAL");
  });

  it("does not quote an INT-typed field's literal", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields, 7
    );
    expect(sql).toContain("u.followers_count > 100");
    expect(sql).not.toContain("'100'");
  });

  it("does not quote an ENUM_INT-typed field's literal", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "is_follow", operator: "=", value: 1 }] },
      fields, 7
    );
    expect(sql).toContain("u.is_follow = 1");
    expect(sql).not.toContain("'1'");
  });
});
