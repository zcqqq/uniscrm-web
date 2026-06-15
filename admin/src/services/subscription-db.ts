import type { SubscriptionRow } from "../types";

export class SubscriptionDB {
  constructor(private db: D1Database) {}

  async getByTenantId(tenantId: string): Promise<SubscriptionRow | null> {
    return this.db
      .prepare("SELECT * FROM subscriptions WHERE tenant_id = ?")
      .bind(tenantId)
      .first<SubscriptionRow>();
  }

  async getByStripeCustomerId(customerId: string): Promise<SubscriptionRow | null> {
    return this.db
      .prepare("SELECT * FROM subscriptions WHERE stripe_customer_id = ?")
      .bind(customerId)
      .first<SubscriptionRow>();
  }

  async getByStripeSubscriptionId(subId: string): Promise<SubscriptionRow | null> {
    return this.db
      .prepare("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?")
      .bind(subId)
      .first<SubscriptionRow>();
  }

  async upsert(tenantId: string, data: Partial<Omit<SubscriptionRow, "id" | "tenant_id">>): Promise<void> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, stripe_subscription_id, tier, status, current_period_end, cancel_at_period_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
           stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
           tier = excluded.tier,
           status = excluded.status,
           current_period_end = excluded.current_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        tenantId,
        data.stripe_customer_id ?? null,
        data.stripe_subscription_id ?? null,
        data.tier ?? "free",
        data.status ?? "active",
        data.current_period_end ?? null,
        data.cancel_at_period_end ?? 0,
        now,
        now
      )
      .run();
  }

  async updateByStripeSubscriptionId(
    stripeSubId: string,
    data: Partial<Omit<SubscriptionRow, "id" | "tenant_id" | "created_at">>
  ): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [now];

    if (data.tier !== undefined) {
      sets.push("tier = ?");
      values.push(data.tier);
    }
    if (data.status !== undefined) {
      sets.push("status = ?");
      values.push(data.status);
    }
    if (data.current_period_end !== undefined) {
      sets.push("current_period_end = ?");
      values.push(data.current_period_end);
    }
    if (data.cancel_at_period_end !== undefined) {
      sets.push("cancel_at_period_end = ?");
      values.push(data.cancel_at_period_end);
    }
    if (data.stripe_subscription_id !== undefined) {
      sets.push("stripe_subscription_id = ?");
      values.push(data.stripe_subscription_id);
    }

    values.push(stripeSubId);

    await this.db
      .prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE stripe_subscription_id = ?`)
      .bind(...values)
      .run();
  }
}
