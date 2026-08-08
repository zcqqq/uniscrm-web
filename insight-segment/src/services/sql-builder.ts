import { SEGMENT_USER_COLUMNS, type InsightField, type ParsedConditions } from "../fields";
import { latestRowsSql, sqlStr, sqlInt } from "../../../shared/r2-sql";

export interface SqlResult {
  sql: string;
}

// R2 SQL has no bind parameters (HTTP endpoint, no prepared-statement support) — every value
// must go through sqlStr/sqlInt. A raw template interpolation here is an injection hole:
// segment conditions come straight from the UI (and, via nl-parser, an LLM).
function literalFor(field: InsightField, v: string | number): string {
  return field.dataType === "INT" || field.dataType === "ENUM_INT" ? sqlInt(Number(v)) : sqlStr(String(v));
}

// QUALIFY-dedup placement (why conditions and is_deleted run in the OUTER query, after the
// window, never in the inner WHERE): see latestRowsSql's doc comment in shared/r2-sql.ts —
// this file now composes through it instead of hand-writing the subquery, so the inner WHERE
// is structurally tenant_id-only and a condition can't drift pre-QUALIFY. On top of that,
// is_deleted is always AND'd at the top level of the outer WHERE, never folded into the
// user-supplied OR group — an OR-logic segment must still exclude deleted users.
//
// Event rows join WITHOUT dedup: each is a discrete occurrence, not an entity with mutable
// "current state", so an event condition is existence, not currency. LEFT JOIN (not INNER): an
// OR-logic segment must still match a user with no qualifying event via the user-side clauses
// alone, and for AND-logic a LEFT JOIN's NULL columns fail the AND clause just as an INNER
// JOIN's absence would.
//
// The join key is NOT `u.id` — `uniscrm.user.id` and `uniscrm.event.user_id` live in two
// different id domains (see docs/adr/0005 and the final review's C2): `id` is the uuid
// link/src/services/entity-state.ts's EntityStateStore.claim() mints, but every `event` row's
// `user_id` is written from the external platform id (webhook.ts's flattenUserPayload ->
// x-users.ts's insertEvents -> buildEventRecord's userId, sourced from the X numeric user id —
// see webhook.ts:295). Joining on `u.id` therefore never matches a single event row, silently
// zeroing every event-conditioned segment. The correct join key is the SOURCE identity:
// `source_user_id` (already in USER_DEDUP_COLUMNS below) plus `channel_id`, since a bare X id is
// only unique within one channel. `tenant_id` is repeated on the event side (not just carried in
// from the user subquery) because R2 SQL's window functions are budget-gated on estimated scan
// size, and a JOIN's ON clause doesn't inherit the other side's WHERE for pruning purposes —
// both tables need their own tenant_id predicate (latestRowsSql enforces this on the join).
//
// NOTE: combining a JOIN with QUALIFY is the least-exercised path in this codebase (R2 SQL
// gained JOINs 2026-05, QUALIFY 2026-06) — needs live verification once the R2 token works
// (see task-9-report.md).
// Key columns the outer query/join needs + every column a segment condition can reference
// (SEGMENT_USER_COLUMNS, derived in fields.ts from metadata/columns.ts) + the dedup/filter
// columns (is_deleted for the outer WHERE, updated_at for the QUALIFY ORDER BY).
const USER_DEDUP_COLUMNS = [
  "id", "channel_id", "source_user_id",
  ...SEGMENT_USER_COLUMNS,
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
  // condition true". latestRowsSql joins outerWhere entries with AND, so listing is_deleted
  // first and the parenthesized group second preserves exactly that shape.
  const outerWhere = ["u.is_deleted = 0"];
  if (clauses.length > 0) outerWhere.push(`(${clauses.join(joiner)})`);

  const sql = latestRowsSql({
    table: "uniscrm.user",
    columns: USER_DEDUP_COLUMNS,
    partitionBy: ["channel_id", "source_user_id"],
    where: [`tenant_id = ${sqlInt(tenantId)}`],
    alias: "u",
    join: needsEvent
      ? `LEFT JOIN uniscrm.event e ON e.user_id = u.source_user_id AND e.channel_id = u.channel_id AND e.tenant_id = ${sqlInt(tenantId)}`
      : undefined,
    outerSelect: "DISTINCT u.id",
    outerWhere,
    limit: 10000,
  });

  return { sql };
}
