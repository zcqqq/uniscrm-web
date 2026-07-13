import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionDB } from "../../src/services/subscription-db";

interface SubRow {
  id: string;
  tenant_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

// Minimal in-memory fake of the D1Database surface, following the existing repo
// convention (see admin/tests/unit/credit-service.test.ts) rather than a real D1 instance.
class FakeSubscriptionsDb {
  rows: SubRow[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("SELECT * FROM subscriptions WHERE tenant_id")) {
          const [tenantId] = this._params as [string];
          return (db.rows.find((r) => r.tenant_id === tenantId) as T) ?? null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO subscriptions")) {
          const [id, tenant_id, stripe_customer_id, stripe_subscription_id, tier, status, current_period_end, cancel_at_period_end, created_at, updated_at] =
            this._params as [string, string, string | null, string | null, string, string, string | null, number, string, string];
          const existing = db.rows.find((r) => r.tenant_id === tenant_id);
          const row: SubRow = { id, tenant_id, stripe_customer_id, stripe_subscription_id, tier, status, current_period_end, cancel_at_period_end, created_at, updated_at };
          if (existing) {
            Object.assign(existing, row);
          } else {
            db.rows.push(row);
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

describe("SubscriptionDB.upsert", () => {
  let db: FakeSubscriptionsDb;
  let subDb: SubscriptionDB;

  beforeEach(() => {
    db = new FakeSubscriptionsDb();
    subDb = new SubscriptionDB(db as unknown as D1Database);
  });

  it("a partial update (e.g. recording stripe_customer_id only) preserves the existing tier/status/period", async () => {
    // Regression test: checkout.ts calls upsert() with only stripe_customer_id to record
    // the Stripe customer before the checkout session exists. This must not reset an
    // existing trialing/active subscription back to tier=free/status=active/period=null.
    await subDb.upsert("42", { tier: "basic", status: "trialing", current_period_end: "2026-08-01T00:00:00.000Z", cancel_at_period_end: 0 });

    await subDb.upsert("42", { stripe_customer_id: "cus_123" });

    const row = db.rows.find((r) => r.tenant_id === "42")!;
    expect(row.stripe_customer_id).toBe("cus_123");
    expect(row.tier).toBe("basic");
    expect(row.status).toBe("trialing");
    expect(row.current_period_end).toBe("2026-08-01T00:00:00.000Z");
  });

  it("a full update (e.g. webhook completing checkout) overwrites tier/status/period as intended", async () => {
    await subDb.upsert("42", { tier: "basic", status: "trialing", current_period_end: "2026-08-01T00:00:00.000Z", cancel_at_period_end: 0 });

    await subDb.upsert("42", {
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_456",
      tier: "pro",
      status: "active",
      current_period_end: "2026-09-01T00:00:00.000Z",
      cancel_at_period_end: 0,
    });

    const row = db.rows.find((r) => r.tenant_id === "42")!;
    expect(row.tier).toBe("pro");
    expect(row.status).toBe("active");
    expect(row.current_period_end).toBe("2026-09-01T00:00:00.000Z");
    expect(row.stripe_subscription_id).toBe("sub_456");
  });

  it("a brand-new tenant with no fields provided still defaults to free/active", async () => {
    await subDb.upsert("99", {});

    const row = db.rows.find((r) => r.tenant_id === "99")!;
    expect(row.tier).toBe("free");
    expect(row.status).toBe("active");
    expect(row.cancel_at_period_end).toBe(0);
  });

  it("preserves created_at across updates instead of resetting it to now", async () => {
    await subDb.upsert("42", { tier: "basic", status: "trialing" });
    const firstCreatedAt = db.rows.find((r) => r.tenant_id === "42")!.created_at;

    await subDb.upsert("42", { tier: "pro", status: "active" });

    const row = db.rows.find((r) => r.tenant_id === "42")!;
    expect(row.created_at).toBe(firstCreatedAt);
  });
});
