import type { InsightField, ParsedConditions } from "../fields";
import { sqlStr, sqlInt } from "../../../shared/r2-sql";

export interface SqlResult {
  sql: string;
}

// R2 SQL has no bind parameters (HTTP endpoint, no prepared-statement support) — every value
// must go through sqlStr/sqlInt. A raw template interpolation here is an injection hole:
// segment conditions come straight from the UI (and, via nl-parser, an LLM).
function literalFor(field: InsightField, v: string | number): string {
  return field.dataType === "INT" || field.dataType === "ENUM_INT" ? sqlInt(Number(v)) : sqlStr(String(v));
}

// uniscrm.user rows are append-only Iceberg — the same (channel_id, source_user_id) accumulates
// many rows over time as the poller/webhook re-observes it, so "does this user match this
// condition" only makes sense against their CURRENT (latest) row, never any historical
// snapshot. That means the dedup (QUALIFY) has to run BEFORE any business-logic condition is
// applied, on a subquery pruned only by tenant_id — a value that's identical across every
// version of a row, so it can never cause what the r2-sql.ts doc comment calls the
// "resurrection" bug: is_deleted and every user-supplied condition below run in the OUTER
// query, after QUALIFY has already picked the single latest row. Putting them in the inner
// WHERE instead (the shape this task's own hand-written brief used) drops the true-latest row
// from the window's input whenever it fails the condition, letting a stale row that happens to
// satisfy it win the "= 1" slot — that's the exact is_deleted bug Task 4's review caught,
// generalized to any condition, and it also breaks OR-logic segments in a second way: an
// is_deleted=0 clause OR'd in with the rest would let a *deleted* user through the moment any
// other clause was true.
//
// Event rows are different: each is a discrete occurrence, not an entity with mutable "current
// state", so an event condition is existence, not currency, and is safe to filter directly on
// the joined row. The join targets `u.id` — the deduped subquery's id, which is stable across
// all of a user's historical row versions (see link/src/services/entity-state.ts's claim()) —
// so joining after dedup, rather than against the raw table, avoids re-introducing the
// multiplicities QUALIFY just collapsed. LEFT JOIN (not INNER): an OR-logic segment must still
// match a user with no qualifying event via the user-side clauses alone, and for AND-logic a
// LEFT JOIN's NULL columns fail the AND clause just as an INNER JOIN's absence would.
//
// NOTE: combining a JOIN with QUALIFY is the least-exercised path in this codebase (R2 SQL
// gained JOINs 2026-05, QUALIFY 2026-06) — needs live verification once the R2 token works
// (see task-9-report.md).
const USER_DEDUP_COLUMNS = [
  "id", "channel_id", "source_user_id", "name", "username",
  "followers_count", "following_count", "verified_type", "is_follow", "is_followed",
  "is_deleted", "updated_at",
];

export function buildSegmentQuery(
  conditions: ParsedConditions,
  fields: InsightField[],
  tenantId: number
): SqlResult {
  const needsEvent = conditions.conditions.some((c) => {
    const field = fields.find((f) => f.propId === c.field);
    return field?.source === "event";
  });

  const clauses: string[] = [];
  for (const cond of conditions.conditions) {
    const field = fields.find((f) => f.propId === cond.field)!;
    const expr = field.sqlExpr;

    if (cond.timeRelative && field.dataType === "DATETIME") {
      // Computed as an ISO literal in JS rather than SQL-side date arithmetic (NOW()/INTERVAL):
      // this codebase's only precedent for R2 SQL date math (analytics/src/index.ts) uses
      // DATE_ADD(anchor_ts, INTERVAL n unit) against a fixed anchor column, never NOW() — the
      // Postgres-style `NOW() - INTERVAL 'n days'` this task's brief suggested is an unverified
      // dialect guess. A literal sidesteps the guess entirely.
      const days = parseInt(cond.timeRelative, 10);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      clauses.push(`${expr} >= ${sqlStr(cutoff)}`);
    } else if (cond.operator === "IN") {
      const vals = cond.value as string[];
      clauses.push(`${expr} IN (${vals.map((v) => literalFor(field, v)).join(", ")})`);
    } else if (cond.operator === "BETWEEN") {
      const [lo, hi] = cond.value as [string, string];
      clauses.push(`${expr} BETWEEN ${literalFor(field, lo)} AND ${literalFor(field, hi)}`);
    } else {
      clauses.push(`${expr} ${cond.operator} ${literalFor(field, cond.value as string | number)}`);
    }
  }

  const joiner = conditions.logic === "OR" ? " OR " : " AND ";
  // is_deleted is always AND'd at the top level, never folded into the user-supplied OR group —
  // an OR-logic segment must still exclude deleted users, not just "match if not deleted OR
  // condition true".
  const conditionGroup = clauses.length > 0 ? ` AND (${clauses.join(joiner)})` : "";

  const join = needsEvent
    ? `\nLEFT JOIN uniscrm.event e ON e.user_id = u.id AND e.tenant_id = ${sqlInt(tenantId)}`
    : "";

  const sql = `SELECT DISTINCT u.id FROM (
  SELECT ${USER_DEDUP_COLUMNS.join(", ")}
  FROM uniscrm.user
  WHERE tenant_id = ${sqlInt(tenantId)}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY channel_id, source_user_id ORDER BY updated_at DESC) = 1
) u${join}
WHERE u.is_deleted = 0${conditionGroup}
LIMIT 10000`;

  return { sql };
}
