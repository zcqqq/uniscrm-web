const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface D1QueryResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; duration: number; rows_read: number; rows_written: number };
}

export class TenantDataDB {
  private baseUrl: string;

  constructor(
    private accountId: string,
    private apiToken: string,
    private dbId: string
  ) {
    this.baseUrl = `${CF_API_BASE}/accounts/${accountId}/d1/database/${dbId}`;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params: params || [] }),
    });
    const data = await res.json() as { result: D1QueryResult<T>[]; success: boolean; errors: { message: string }[] };
    if (!data.success) {
      throw new Error(`D1 query failed: ${data.errors?.[0]?.message || "unknown error"}`);
    }
    return data.result[0].results;
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const res = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params: params || [] }),
    });
    const data = await res.json() as { result: D1QueryResult[]; success: boolean; errors: { message: string }[] };
    if (!data.success) {
      throw new Error(`D1 run failed: ${data.errors?.[0]?.message || "unknown error"}`);
    }
    return { changes: data.result[0].meta.changes };
  }

  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<D1QueryResult[]> {
    const results: D1QueryResult[] = [];
    for (const stmt of statements) {
      const res = await fetch(`${this.baseUrl}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: stmt.sql, params: stmt.params || [] }),
      });
      const data = await res.json() as { result: D1QueryResult[]; success: boolean; errors: { message: string }[] };
      if (!data.success) {
        throw new Error(`D1 batch failed: ${data.errors?.[0]?.message || "unknown error"}`);
      }
      results.push(data.result[0]);
    }
    return results;
  }

  getDbId(): string {
    return this.dbId;
  }
}
