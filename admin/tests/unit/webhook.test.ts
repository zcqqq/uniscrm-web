import { describe, it, expect, beforeEach } from "vitest";
import type Stripe from "stripe";
import { handleSubscriptionUpdated, subscriptionPeriodEnd } from "../../src/routes/webhook";
import { SubscriptionDB } from "../../src/services/subscription-db";
import type { Tier } from "../../../shared/plans";

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

// Fake ADMIN_DB backing SubscriptionDB, following the repo's existing fake-D1 test convention
// (admin/tests/unit/credit-service.test.ts) rather than a real Workers/D1 test environment.
class FakeAdminDb {
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
        if (sql.includes("WHERE stripe_subscription_id = ?")) {
          const [subId] = this._params as [string];
          return (db.rows.find((r) => r.stripe_subscription_id === subId) as T) ?? null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("UPDATE subscriptions SET") && sql.includes("WHERE stripe_subscription_id = ?")) {
          const subId = this._params[this._params.length - 1] as string;
          const row = db.rows.find((r) => r.stripe_subscription_id === subId);
          if (row) {
            // SubscriptionDB.updateByStripeSubscriptionId builds its SET clause dynamically
            // (only include fields that were passed in), so the bind-param index for any given
            // column shifts depending on which fields the caller supplied. Reading the column
            // names back out of the SQL itself, rather than assuming a fixed position, keeps
            // this fake correct regardless of that shape.
            const setClauses = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).split(",").map((s) => s.trim());
            setClauses.forEach((clause, i) => {
              if (clause.startsWith("tier")) row.tier = this._params[i] as string;
              if (clause.startsWith("current_period_end")) row.current_period_end = this._params[i] as string | null;
            });
          }
        }
        return { meta: { changes: 1 } };
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
        const [tenantId] = this._params as [number];
        if (sql.includes("SET is_active = 0")) {
          for (const ch of db.channels) {
            if (ch.tenant_id === tenantId && (ch.channel_type === "TWITTER" || ch.channel_type === "X") && ch.is_byok === 0 && ch.is_active === 1) {
              ch.is_active = 0;
              ch.deactivated_reason = "tier_limit";
            }
          }
        } else if (sql.includes("SET is_active = 1")) {
          for (const ch of db.channels) {
            if (ch.tenant_id === tenantId && (ch.channel_type === "TWITTER" || ch.channel_type === "X") && ch.is_byok === 0 && ch.is_active === 0 && ch.deactivated_reason === "tier_limit") {
              ch.is_active = 1;
              ch.deactivated_reason = null;
            }
          }
        }
        return { meta: { changes: 1 } };
      },
    };
  }
}

const priceMap: Record<string, Tier> = { price_basic: "basic", price_pro: "pro" };

function fakeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    status: "active",
    current_period_end: Math.floor(Date.now() / 1000),
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_basic" } }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("handleSubscriptionUpdated — link.x channel enforcement", () => {
  let adminDb: FakeAdminDb;
  let linkDb: FakeLinkDb;
  let db: SubscriptionDB;

  beforeEach(() => {
    adminDb = new FakeAdminDb();
    linkDb = new FakeLinkDb();
    db = new SubscriptionDB(adminDb as unknown as D1Database);
    adminDb.rows.push({
      id: "s1", tenant_id: "42", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
      tier: "pro", status: "active", current_period_end: null, cancel_at_period_end: 0,
      created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z",
    });
  });

  it("deactivates the non-BYOK X channel when a tenant downgrades to basic (link.x disallowed)", async () => {
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 0, is_active: 1, deactivated_reason: null });

    await handleSubscriptionUpdated(db, linkDb as unknown as D1Database, fakeSubscription({ items: { data: [{ price: { id: "price_basic" } }] } } as any), priceMap);

    expect(linkDb.channels[0].is_active).toBe(0);
    expect(linkDb.channels[0].deactivated_reason).toBe("tier_limit");
  });

  it("reactivates a tier-paused X channel when the tenant upgrades back to pro", async () => {
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 0, is_active: 0, deactivated_reason: "tier_limit" });

    await handleSubscriptionUpdated(db, linkDb as unknown as D1Database, fakeSubscription({ items: { data: [{ price: { id: "price_pro" } }] } } as any), priceMap);

    expect(linkDb.channels[0].is_active).toBe(1);
    expect(linkDb.channels[0].deactivated_reason).toBe(null);
  });

  it("does not reactivate a channel the user disconnected themselves", async () => {
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 0, is_active: 0, deactivated_reason: null });

    await handleSubscriptionUpdated(db, linkDb as unknown as D1Database, fakeSubscription({ items: { data: [{ price: { id: "price_pro" } }] } } as any), priceMap);

    expect(linkDb.channels[0].is_active).toBe(0); // untouched — not a tier-limit pause
  });

  it("never touches BYOK X channels", async () => {
    linkDb.channels.push({ tenant_id: 42, channel_type: "X", is_byok: 1, is_active: 1, deactivated_reason: null });

    await handleSubscriptionUpdated(db, linkDb as unknown as D1Database, fakeSubscription({ items: { data: [{ price: { id: "price_basic" } }] } } as any), priceMap);

    expect(linkDb.channels[0].is_active).toBe(1);
  });
});

// Regression coverage for the 2026-09-13/17 production incident: this account's webhook
// endpoint has no api_version pinned, so its default rolled forward to 2026-06-24.dahlia,
// which moved Subscription.current_period_end onto each subscription item. The installed
// stripe-node 17.7.0 types (built for 2025-02-24.acacia) still declare it on the top-level
// object, so nothing caught this at compile time — every checkout.session.completed and
// customer.subscription.updated delivery threw `RangeError: Invalid time value` at
// `new Date(undefined * 1000).toISOString()`, which Stripe recorded as a failed webhook.
describe("subscriptionPeriodEnd — API version drift (acacia vs dahlia)", () => {
  it("reads current_period_end from the subscription item when it is absent from the top level (dahlia+)", () => {
    const subscription = fakeSubscription({
      current_period_end: undefined,
      items: { data: [{ price: { id: "price_basic" }, current_period_end: 1792225599 }] },
    } as any);

    expect(subscriptionPeriodEnd(subscription)).toBe(1792225599);
  });

  it("falls back to the top-level field when the item has none (pre-dahlia)", () => {
    const subscription = fakeSubscription({
      current_period_end: 1700000000,
      items: { data: [{ price: { id: "price_basic" } }] },
    } as any);

    expect(subscriptionPeriodEnd(subscription)).toBe(1700000000);
  });

  it("prefers the item's value when both are present", () => {
    const subscription = fakeSubscription({
      current_period_end: 1,
      items: { data: [{ price: { id: "price_basic" }, current_period_end: 2 }] },
    } as any);

    expect(subscriptionPeriodEnd(subscription)).toBe(2);
  });
});

describe("handleSubscriptionUpdated — dahlia-shaped payload (no top-level current_period_end)", () => {
  it("stores a valid current_period_end instead of throwing RangeError('Invalid time value')", async () => {
    const adminDb = new FakeAdminDb();
    const linkDb = new FakeLinkDb();
    const db = new SubscriptionDB(adminDb as unknown as D1Database);
    adminDb.rows.push({
      id: "s1", tenant_id: "42", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
      tier: "pro", status: "active", current_period_end: null, cancel_at_period_end: 0,
      created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z",
    });
    const subscription = fakeSubscription({
      current_period_end: undefined,
      items: { data: [{ price: { id: "price_basic" }, current_period_end: 1792225599 }] },
    } as any);

    await handleSubscriptionUpdated(db, linkDb as unknown as D1Database, subscription, priceMap);

    expect(adminDb.rows[0].current_period_end).toBe(new Date(1792225599 * 1000).toISOString());
  });
});
