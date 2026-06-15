import type { FieldDefinition, ParsedConditions } from "../metadata";

export interface SqlResult {
  sql: string;
  params: unknown[];
}

export function buildSegmentQuery(
  conditions: ParsedConditions,
  tenantId: string,
  fields: FieldDefinition[]
): SqlResult {
  const needsEvent = conditions.conditions.some((c) => {
    const field = fields.find((f) => f.propId === c.field);
    return field?.source === "event_x";
  });

  let sql = "SELECT DISTINCT user_x.id FROM user_x";
  const params: unknown[] = [];

  if (needsEvent) {
    sql += " INNER JOIN event_x ON event_x.user_id = user_x.id AND event_x.tenant_id = ?";
    params.push(tenantId);
  }

  sql += " WHERE user_x.tenant_id = ?";
  params.push(tenantId);

  const clauses: string[] = [];

  for (const cond of conditions.conditions) {
    const field = fields.find((f) => f.propId === cond.field)!;
    const expr = field.sqlExpr;

    if (cond.timeRelative && field.dataType === "DATETIME") {
      const days = parseInt(cond.timeRelative);
      clauses.push(`${expr} >= datetime('now', ?)`);
      params.push(`-${days} days`);
    } else {
      switch (cond.operator) {
        case "=":
        case "!=":
        case ">":
        case "<":
        case ">=":
        case "<=":
          clauses.push(`${expr} ${cond.operator} ?`);
          params.push(field.dataType === "INT" ? Number(cond.value) : cond.value);
          break;
        case "IN": {
          const vals = cond.value as string[];
          clauses.push(`${expr} IN (${vals.map(() => "?").join(",")})`);
          params.push(...vals);
          break;
        }
        case "BETWEEN": {
          const [lo, hi] = cond.value as [string, string];
          clauses.push(`${expr} BETWEEN ? AND ?`);
          params.push(lo, hi);
          break;
        }
      }
    }
  }

  const joiner = conditions.logic === "OR" ? " OR " : " AND ";
  if (clauses.length > 0) {
    sql += ` AND (${clauses.join(joiner)})`;
  }

  return { sql, params };
}
