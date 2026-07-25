// R2 SQL's HTTP endpoint doesn't support bind parameters—SQL must be concatenated from strings,
// so every external value must go through sqlStr/sqlInt. Direct template interpolation is an
// injection vector and is forbidden.
export interface R2SqlEnv {
  CF_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
  R2_CATALOG_TOKEN: string;
}

export class R2SqlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "R2SqlError";
  }
}

export function sqlStr(v: string): string {
  if (v.includes("\0")) throw new Error("sqlStr: value contains a NUL byte");
  return `'${v.replace(/'/g, "''")}'`;
}

export function sqlInt(v: number): string {
  if (!Number.isSafeInteger(v)) throw new Error(`sqlInt: ${v} is not a safe integer`);
  return String(v);
}

export interface LatestRowsOpts {
  table: string;
  columns: string[];
  partitionBy: string[];
  where: string[];
  // Filters applied AFTER the QUALIFY dedup window, on the surviving one-row-per-key result —
  // as opposed to `where`, which filters BEFORE the window runs (see latestRowsSql doc comment
  // for why is_deleted must go here, never in `where`). Any column referenced here must also be
  // in `columns`, since the outer query can only see what the inner SELECT produced.
  outerWhere?: string[];
  orderBy?: string;
  limit?: number;
}

// Iceberg sinks are append-only; the same business key will have multiple rows. QUALIFY +
// ROW_NUMBER deduplicates at read time by picking the row with the latest updated_at,
// so correctness no longer depends on analytics running its daily 02:00 compaction.
//
// `where` vs `outerWhere` matters more than it looks: SQL evaluates WHERE before QUALIFY, so a
// filter placed in `where` removes rows from the *input* to the dedup window, not from its
// output. Concretely — content c1 written at T1 (is_deleted=0), then logically deleted at T2
// (tombstone row, is_deleted=1, updated_at=T2): filtering `is_deleted = 0` in `where` deletes
// the T2 tombstone before the window ever sees it, leaving the T1 row alone in its partition —
// which the window then happily returns as "latest". The deleted row resurrects itself, and
// every future delete is equally inert. Post-dedup conditions (is_deleted, and anything else
// that depends on "the current state of this business key" rather than "which raw rows to
// consider") MUST go in `outerWhere`, which wraps the QUALIFY query in a subquery and filters
// after it. `tenant_id` deliberately stays out of `outerWhere`'s reach — it's a partition-
// pruning filter that belongs before the window (and cheaper that way), not a post-dedup
// condition, so the guard below only ever inspects `where`.
export function latestRowsSql(opts: LatestRowsOpts): string {
  if (!opts.where.some((w) => /\btenant_id\s*=/.test(w))) {
    throw new Error("latestRowsSql: every query must filter on tenant_id");
  }

  const inner = [
    `SELECT ${opts.columns.join(", ")} FROM ${opts.table}`,
    `WHERE ${opts.where.join(" AND ")}`,
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY ${opts.partitionBy.join(", ")} ORDER BY updated_at DESC) = 1`,
  ].join("\n");

  const parts: string[] = [];
  if (opts.outerWhere && opts.outerWhere.length > 0) {
    parts.push(`SELECT ${opts.columns.join(", ")} FROM (`, inner, `) WHERE ${opts.outerWhere.join(" AND ")}`);
  } else {
    parts.push(inner);
  }
  if (opts.orderBy) parts.push(`ORDER BY ${opts.orderBy}`);
  if (opts.limit !== undefined) parts.push(`LIMIT ${sqlInt(opts.limit)}`);
  return parts.join("\n");
}

interface R2SqlResponse<T> {
  result?: { rows?: T[] };
  error?: string;
}

export async function r2Query<T>(env: R2SqlEnv, sql: string): Promise<T[]> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_BUCKET}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.R2_CATALOG_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ warehouse: env.R2_WAREHOUSE, query: sql }),
  });

  const text = await res.text();
  let body: R2SqlResponse<T>;
  try {
    body = JSON.parse(text) as R2SqlResponse<T>;
  } catch {
    throw new R2SqlError(`r2Query: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
  }

  // R2 SQL can return {"error": "..."} inside an HTTP 200 response (seen in analytics/CLAUDE.md:40010).
  // Checking only res.ok would silently treat errors as "zero rows"—the exact failure mode we're
  // preventing.
  if (!res.ok || body.error) {
    throw new R2SqlError(`r2Query failed (HTTP ${res.status}): ${body.error ?? text.slice(0, 300)}`, res.status);
  }
  return body.result?.rows ?? [];
}
