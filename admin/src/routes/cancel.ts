import type { Context } from "hono";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";
import { createStripeClient, cancelSubscription } from "../services/stripe";

export async function cancelRoute(c: Context<{ Bindings: Env }>) {
  const { tenant_id } = await c.req.json<{ tenant_id: string }>();

  const db = new SubscriptionDB(c.env.DB);
  const row = await db.getByTenantId(tenant_id);

  if (!row?.stripe_subscription_id) {
    return c.json({ error: "No active subscription" }, 400);
  }

  try {
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
    await cancelSubscription(stripe, row.stripe_subscription_id);

    await db.updateByStripeSubscriptionId(row.stripe_subscription_id, {
      cancel_at_period_end: 1,
    });

    return c.json({ ok: true });
  } catch (err) {
    console.log(JSON.stringify({ error: "cancel_failed", detail: String(err) }));
    return c.json({ error: err instanceof Error ? err.message : "Cancel failed" }, 500);
  }
}
