import { describe, it, expect, beforeEach } from "vitest";
import { CreditService, getActiveSubscriptionTier } from "../../../shared/credit-service";

// Minimal in-memory fake of the D1Database surface used by CreditService, following the
// existing repo convention of mocking external dependencies directly (see web/tests/services/email.test.ts)
// rather than spinning up a real Workers/D1 test environment.
class FakeD1 {
  usageRows: { id: string; tenant_id: number; flow_id: string | null; channel_id: string | null; action_event_type: string; credit_micros: number; created_at: string }[] = [];
  subscriptions: { tenant_id: number; tier: string; status: string; created_at: string }[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (db_sqlIncludes(sql, "FROM credit_usage_log") && db_sqlIncludes(sql, "SUM(")) {
          const [tenantId, start, end] = this._params as [number, string, string];
          const used = db.usageRows
            .filter((r) => r.tenant_id === tenantId && r.created_at >= start && r.created_at < end)
            .reduce((sum, r) => sum + r.credit_micros, 0);
          return { used } as T;
        }
        if (db_sqlIncludes(sql, "FROM credit_usage_log") && db_sqlIncludes(sql, "COUNT(*)")) {
          const [tenantId] = this._params as [number];
          const count = db.usageRows.filter((r) => r.tenant_id === tenantId).length;
          return { count } as T;
        }
        if (db_sqlIncludes(sql, "FROM subscriptions")) {
          const [tenantId] = this._params as [number];
          const row = db.subscriptions.find((s) => s.tenant_id === tenantId && s.status === "active");
          return (row as T) ?? null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (db_sqlIncludes(sql, "FROM credit_usage_log")) {
          const [tenantId, limit, offset] = this._params as [number, number, number];
          const rows = db.usageRows
            .filter((r) => r.tenant_id === tenantId)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(offset, offset + limit);
          return { results: rows as T[] };
        }
        return { results: [] };
      },
      async run() {
        if (db_sqlIncludes(sql, "INSERT INTO credit_usage_log")) {
          const [id, tenant_id, flow_id, channel_id, action_event_type, credit_micros, created_at] = this._params as [
            string, number, string | null, string | null, string, number, string
          ];
          db.usageRows.push({ id, tenant_id, flow_id, channel_id, action_event_type, credit_micros, created_at });
        }
        return { meta: { changes: 1 } };
      },
    };
  }
}

function db_sqlIncludes(sql: string, needle: string): boolean {
  return sql.includes(needle);
}

describe("CreditService", () => {
  let fakeDb: FakeD1;
  let svc: CreditService;

  beforeEach(() => {
    fakeDb = new FakeD1();
    svc = new CreditService(fakeDb as unknown as D1Database);
  });

  it("computes full balance with no usage", async () => {
    const balance = await svc.getBalance(1, "basic", "2026-01-01T00:00:00.000Z", new Date("2026-01-15T00:00:00Z"));
    expect(balance.monthlyCreditMicros).toBe(5_000_000);
    expect(balance.usedMicros).toBe(0);
    expect(balance.balanceMicros).toBe(5_000_000);
  });

  it("deducts logged usage within the current period only", async () => {
    await svc.logUsage({ tenantId: 1, flowId: "flow-1", channelId: "chan-1", actionEventType: "follow-user", creditMicros: 15_000 });
    fakeDb.usageRows[0].created_at = "2026-01-10T00:00:00.000Z"; // inside Jan 1 - Feb 1 period
    // usage from a previous period should not count
    await svc.logUsage({ tenantId: 1, flowId: "flow-1", channelId: "chan-1", actionEventType: "follow-user", creditMicros: 999_999 });
    fakeDb.usageRows[1].created_at = "2025-12-15T00:00:00.000Z";

    const balance = await svc.getBalance(1, "basic", "2026-01-01T00:00:00.000Z", new Date("2026-01-15T00:00:00Z"));
    expect(balance.usedMicros).toBe(15_000);
    expect(balance.balanceMicros).toBe(5_000_000 - 15_000);
  });

  it("balance goes to zero/negative once allowance is exhausted", async () => {
    for (let i = 0; i < 400; i++) {
      await svc.logUsage({ tenantId: 2, actionEventType: "follow-user", creditMicros: 15_000 });
    }
    fakeDb.usageRows.forEach((r) => (r.created_at = "2026-01-10T00:00:00.000Z"));
    const balance = await svc.getBalance(2, "basic", "2026-01-01T00:00:00.000Z", new Date("2026-01-15T00:00:00Z"));
    expect(balance.balanceMicros).toBeLessThanOrEqual(0);
  });

  it("lists usage entries paginated, newest first", async () => {
    await svc.logUsage({ tenantId: 3, actionEventType: "follow-user", creditMicros: 15_000 });
    await svc.logUsage({ tenantId: 3, actionEventType: "unfollow-user", creditMicros: 10_000 });
    fakeDb.usageRows[0].created_at = "2026-01-01T00:00:00.000Z";
    fakeDb.usageRows[1].created_at = "2026-01-02T00:00:00.000Z";

    const { entries, total } = await svc.listUsage(3, { limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(entries[0].action_event_type).toBe("unfollow-user"); // newest first
  });
});

describe("getActiveSubscriptionTier", () => {
  it("returns null for free/no subscription", async () => {
    const fakeDb = new FakeD1();
    const tier = await getActiveSubscriptionTier(fakeDb as unknown as D1Database, 99);
    expect(tier).toBeNull();
  });

  it("returns tier + createdAt for an active paid subscription", async () => {
    const fakeDb = new FakeD1();
    fakeDb.subscriptions.push({ tenant_id: 5, tier: "pro", status: "active", created_at: "2026-02-01T00:00:00.000Z" });
    const tier = await getActiveSubscriptionTier(fakeDb as unknown as D1Database, 5);
    expect(tier).toEqual({ tier: "pro", createdAt: "2026-02-01T00:00:00.000Z" });
  });
});
