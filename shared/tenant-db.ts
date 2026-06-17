const TENANT_EXEMPT_TABLES = new Set(["magic_links", "tenants", "d1_migrations"]);

const FROM_RE = /\bFROM\s+(\w+)/gi;
const JOIN_RE = /\bJOIN\s+(\w+)/gi;
const INSERT_RE = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i;
const UPDATE_RE = /\bUPDATE\s+(\w+)/i;
const DELETE_RE = /\bDELETE\s+FROM\s+(\w+)/i;

function extractTables(sql: string, pattern: RegExp): string[] {
  const tables: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags);
  while ((match = re.exec(sql)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}

function needsIsolation(table: string): boolean {
  return !TENANT_EXEMPT_TABLES.has(table.toLowerCase());
}

function injectSelect(sql: string, tenantId: number): { sql: string; params: unknown[] } {
  const fromTables = extractTables(sql, FROM_RE);
  const joinTables = extractTables(sql, JOIN_RE);
  const allTables = [...fromTables, ...joinTables].filter(needsIsolation);

  if (allTables.length === 0) return { sql, params: [] };

  const conditions = allTables.map((t) => `${t}.tenant_id = ?`);
  const params = allTables.map(() => tenantId);

  const whereIdx = sql.search(/\bWHERE\b/i);
  const orderIdx = sql.search(/\bORDER\s+BY\b/i);
  const groupIdx = sql.search(/\bGROUP\s+BY\b/i);
  const limitIdx = sql.search(/\bLIMIT\b/i);
  const havingIdx = sql.search(/\bHAVING\b/i);

  if (whereIdx >= 0) {
    const insertPos = whereIdx + sql.slice(whereIdx).match(/\bWHERE\b/i)![0].length;
    const injected = ` ${conditions.join(" AND ")} AND`;
    return { sql: sql.slice(0, insertPos) + injected + sql.slice(insertPos), params };
  }

  const clausePositions = [orderIdx, groupIdx, limitIdx, havingIdx].filter((i) => i >= 0);
  const insertPos = clausePositions.length > 0 ? Math.min(...clausePositions) : sql.length;
  const injected = ` WHERE ${conditions.join(" AND ")}`;
  return { sql: sql.slice(0, insertPos) + injected + sql.slice(insertPos), params };
}

function injectInsert(sql: string, tenantId: number): { sql: string; params: unknown[] } {
  const match = INSERT_RE.exec(sql);
  if (!match || !needsIsolation(match[1])) return { sql, params: [] };

  const parenOpen = sql.indexOf("(", match.index + match[0].length);
  if (parenOpen < 0) return { sql, params: [] };

  const parenClose = sql.indexOf(")", parenOpen);
  const columns = sql.slice(parenOpen + 1, parenClose);

  if (columns.includes("tenant_id")) return { sql, params: [] };

  const valuesMatch = sql.match(/\bVALUES\s*\(/i);
  if (!valuesMatch) return { sql, params: [] };
  const valuesStart = sql.indexOf("(", sql.indexOf(valuesMatch[0]));
  const valuesEnd = sql.indexOf(")", valuesStart);

  const newSql =
    sql.slice(0, parenClose) + ", tenant_id" + sql.slice(parenClose, valuesEnd) + ", ?" + sql.slice(valuesEnd);

  return { sql: newSql, params: [tenantId] };
}

function injectUpdateOrDelete(sql: string, tenantId: number): { sql: string; params: unknown[] } {
  const updateMatch = UPDATE_RE.exec(sql);
  const deleteMatch = DELETE_RE.exec(sql);
  const table = updateMatch?.[1] || deleteMatch?.[1];

  if (!table || !needsIsolation(table)) return { sql, params: [] };

  const whereIdx = sql.search(/\bWHERE\b/i);
  if (whereIdx >= 0) {
    return { sql: sql + " AND tenant_id = ?", params: [tenantId] };
  }
  return { sql: sql + " WHERE tenant_id = ?", params: [tenantId] };
}

function injectTenantId(sql: string, tenantId: number): { sql: string; params: unknown[] } {
  const trimmed = sql.trimStart();
  const upper = trimmed.slice(0, 10).toUpperCase();

  if (upper.startsWith("SELECT")) return injectSelect(sql, tenantId);
  if (upper.startsWith("INSERT")) return injectInsert(sql, tenantId);
  if (upper.startsWith("UPDATE")) return injectUpdateOrDelete(sql, tenantId);
  if (upper.startsWith("DELETE")) return injectUpdateOrDelete(sql, tenantId);

  return { sql, params: [] };
}

class TenantStatement {
  private userParams: unknown[] = [];

  constructor(
    private db: D1Database,
    private originalSql: string,
    private tenantId: number
  ) {}

  bind(...params: unknown[]): this {
    this.userParams = params;
    return this;
  }

  private buildFinal(): D1PreparedStatement {
    const { sql, params: tenantParams } = injectTenantId(this.originalSql, this.tenantId);
    const allParams = [...tenantParams, ...this.userParams];
    return allParams.length > 0
      ? this.db.prepare(sql).bind(...allParams)
      : this.db.prepare(sql);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.buildFinal().first<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.buildFinal().all<T>();
  }

  async run(): Promise<D1Result> {
    return this.buildFinal().run();
  }

  raw(): D1PreparedStatement {
    return this.buildFinal();
  }
}

export class TenantDB {
  constructor(
    private db: D1Database,
    private tenantId: number
  ) {}

  prepare(sql: string): TenantStatement {
    return new TenantStatement(this.db, sql, this.tenantId);
  }

  async batch(statements: TenantStatement[]): Promise<D1Result[]> {
    const prepared = statements.map((s) => s.raw());
    return this.db.batch(prepared);
  }

  getTenantId(): number {
    return this.tenantId;
  }
}
