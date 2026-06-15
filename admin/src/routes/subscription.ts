import type { Context } from "hono";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";

export async function subscriptionRoute(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param("tenantId")!;
  const db = new SubscriptionDB(c.env.DB);
  const row = await db.getByTenantId(tenantId);

  if (!row) {
    return c.json({
      tier: "free",
      status: "active",
      subscription: null,
    });
  }

  return c.json({
    tier: row.tier,
    status: row.status,
    subscription: {
      id: row.id,
      stripe_subscription_id: row.stripe_subscription_id,
      current_period_end: row.current_period_end,
      cancel_at_period_end: row.cancel_at_period_end,
    },
  });
}
