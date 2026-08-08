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

// For numeric literals that may legitimately be floats (filter values, window sizes). Use
// sqlInt for ids/tenant ids where a fraction would itself be a bug.
export function sqlNum(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`sqlNum: ${v} is not a finite number`);
  return String(v);
}

// Identifier-position values (column/field names) can never be escaped into safety the way
// string literals can — the only sound defense is an explicit allowlist of real column names.
// Callers derive their allowlists from metadata/columns.ts (plus each table's fixed
// identity columns) so a prop added to the registry is filterable everywhere at once.
export function sqlIdent(name: string, allowed: ReadonlySet<string>): string {
  if (!allowed.has(name)) throw new Error(`sqlIdent: "${name}" is not an allowed column here`);
  return name;
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
  // --- outer-query shaping (any of these switches to the subquery form) ---
  // Alias for the deduped subquery (e.g. "u"), so outerSelect/outerWhere/join can reference
  // its columns as u.<col>. Required when `join` is set.
  alias?: string;
  // A JOIN clause appended after the aliased subquery (e.g. insight-segment's
  // `LEFT JOIN uniscrm.event e ON e.user_id = u.source_user_id AND ... AND e.tenant_id = N`).
  // Joined rows are NOT deduped — appropriate for occurrence tables like uniscrm.event, whose
  // rows are discrete facts rather than entities with a mutable "current state". The clause
  // must carry its own tenant_id predicate: R2 SQL's window functions are budget-gated on
  // estimated scan size and a JOIN's ON clause doesn't inherit the other side's WHERE for
  // pruning, so each table needs its own tenant_id filter (enforced below).
  join?: string;
  // Outer SELECT list replacing the default (columns re-projected verbatim): aggregates over
  // the deduped rows (`COUNT(DISTINCT id) as value`), or `DISTINCT u.id`. This is how
  // SUM/AVG/COUNT run on one-row-per-business-key input instead of raw append-only rows.
  outerSelect?: string;
  // Extra FROM sources appended right after the subquery, e.g. ", bounds" to cross join a
  // caller-supplied CTE (analytics' bucketing bounds).
  outerFrom?: string;
  groupBy?: string;
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
  if (opts.join !== undefined) {
    if (!opts.alias) throw new Error("latestRowsSql: join requires an alias for the deduped subquery");
    if (!/\btenant_id\s*=/.test(opts.join)) {
      throw new Error("latestRowsSql: join clause must filter tenant_id on the joined table (each side needs its own pruning predicate)");
    }
  }

  const inner = [
    `SELECT ${opts.columns.join(", ")} FROM ${opts.table}`,
    `WHERE ${opts.where.join(" AND ")}`,
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY ${opts.partitionBy.join(", ")} ORDER BY updated_at DESC) = 1`,
  ].join("\n");

  const subqueryForm =
    (opts.outerWhere && opts.outerWhere.length > 0) ||
    opts.alias !== undefined || opts.join !== undefined ||
    opts.outerSelect !== undefined || opts.outerFrom !== undefined || opts.groupBy !== undefined;

  const parts: string[] = [];
  if (subqueryForm) {
    parts.push(`SELECT ${opts.outerSelect ?? opts.columns.join(", ")} FROM (`, inner);
    let close = `)${opts.alias ? ` ${opts.alias}` : ""}${opts.outerFrom ?? ""}`;
    if (opts.join) {
      parts.push(close, opts.join);
      if (opts.outerWhere && opts.outerWhere.length > 0) parts.push(`WHERE ${opts.outerWhere.join(" AND ")}`);
    } else {
      if (opts.outerWhere && opts.outerWhere.length > 0) close += ` WHERE ${opts.outerWhere.join(" AND ")}`;
      parts.push(close);
    }
    if (opts.groupBy) parts.push(`GROUP BY ${opts.groupBy}`);
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
  success?: boolean;
  errors?: unknown;
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

  // .clone() before reading: under test mocks a single Response instance may be shared across
  // multiple r2Query callers within one tick (e.g. flow's recomputeFlowCounts issuing two
  // queries against one mockResolvedValue); reading via a clone avoids consuming that shared
  // body. No behavior change against real fetch() responses (always distinct objects).
  const text = await res.clone().text();
  let body: R2SqlResponse<T>;
  try {
    body = JSON.parse(text) as R2SqlResponse<T>;
  } catch {
    throw new R2SqlError(`r2Query: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
  }

  // R2 SQL can report failure inside an HTTP 200 response, in two shapes: {"error": "..."}
  // (seen in analytics/CLAUDE.md:40010) and the Cloudflare API envelope {"success": false,
  // "errors": [...]} (seen by flow's count/node-log queries). Checking only res.ok would
  // silently treat both as "zero rows"—the exact failure mode we're preventing.
  if (!res.ok || body.error || body.success === false) {
    const detail = body.error ?? (body.errors !== undefined ? JSON.stringify(body.errors).slice(0, 300) : text.slice(0, 300));
    throw new R2SqlError(`r2Query failed (HTTP ${res.status}): ${detail}`, res.status);
  }
  return body.result?.rows ?? [];
}
