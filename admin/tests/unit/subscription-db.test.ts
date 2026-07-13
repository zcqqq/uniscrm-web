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

interface ChannelRow {
  tenant_id: number;
  channel_type: string;
  is_byok: number;
  is_active: number;
  deactivated_reason: string | null;
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
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("SELECT tenant_id FROM subscriptions")) {
          const [end] = this._params as [string];
          const results = db.rows.filter(
            (r) => r.current_period_end !== null && r.current_period_end < end && r.stripe_subscription_id === null && r.tier !== "free"
          );
          return { results: results.map((r) => ({ tenant_id: r.tenant_id })) as T[] };
        }
        return { results: [] };
      },
      async run() {
        if (sql.includes("UPDATE subscriptions") && sql.includes("SET tier = 'free'")) {
          const [, end] = this._params as [string, string];
          let changes = 0;
          for (const r of db.rows) {
            if (r.current_period_end !== null && r.current_period_end < end && r.stripe_subscription_id === null && r.tier !== "free") {
              r.tier = "free";
              r.status = "expired";
              changes++;
            }
          }
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

class FakeLinkDb {
  channels: ChannelRow[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async run() {
        if (sql.includes("SET is_active = 0")) {
          const [tenantId] = this._params as [number];
          for (const ch of db.channels) {
            if (ch.tenant_id === tenantId && (ch.channel_type === "TWITTER" || ch.channel_type === "X") && ch.is_byok === 0 && ch.is_active === 1) {
              ch.is_active = 0;
              ch.deactivated_reason = "tier_limit";
            }
          }
        }
        return { meta: { changes: 1 } };
      },
    };
  }
}

describe("SubscriptionDB.expireNonStripeSubscriptions", () => {
  let db: FakeSubscriptionsDb;
  let linkDb: FakeLinkDb;
  let subDb: SubscriptionDB;

  beforeEach(() => {
    db = new FakeSubscriptionsDb();
    linkDb = new FakeLinkDb();
    subDb = new SubscriptionDB(db as unknown as D1Database);
  });

  it("deactivates non-BYOK X channels for tenants whose trial just expired", async () => {
    db.rows.push({
      id: "s1", tenant_id: "42", stripe_customer_id: null, stripe_subscription_id: null,
      tier: "basic", status: "trialing", current_period_end: "2020-01-01T00:00:00.000Z",
      cancel_at_period_end: 0, created_at: "2019-12-01T00:00:00.000Z", updated_at: "2019-12-01T00:00:00.000Z",
    });
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 0, is_active: 1, deactivated_reason: null });
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 1, is_active: 1, deactivated_reason: null }); // BYOK, untouched

    const count = await subDb.expireNonStripeSubscriptions(linkDb as unknown as D1Database);

    expect(count).toBe(1);
    expect(linkDb.channels[0].is_active).toBe(0);
    expect(linkDb.channels[0].deactivated_reason).toBe("tier_limit");
    expect(linkDb.channels[1].is_active).toBe(1); // BYOK channel untouched
  });

  it("does not touch channels for tenants whose subscription is still valid", async () => {
    db.rows.push({
      id: "s2", tenant_id: "7", stripe_customer_id: null, stripe_subscription_id: null,
      tier: "basic", status: "trialing", current_period_end: "2099-01-01T00:00:00.000Z",
      cancel_at_period_end: 0, created_at: "2019-12-01T00:00:00.000Z", updated_at: "2019-12-01T00:00:00.000Z",
    });
    linkDb.channels.push({ tenant_id: 7, channel_type: "X", is_byok: 0, is_active: 1, deactivated_reason: null });

    await subDb.expireNonStripeSubscriptions(linkDb as unknown as D1Database);

    expect(linkDb.channels[0].is_active).toBe(1);
  });
});
