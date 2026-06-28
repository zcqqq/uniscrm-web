import type { Context } from "hono";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";
import { createStripeClient, findOrCreateCustomer, createCheckoutSession } from "../services/stripe";

export async function checkoutRoute(c: Context<{ Bindings: Env }>) {
  const { tenant_id, tier, return_url, cancel_url } = await c.req.json<{
    tenant_id: string;
    tier: string;
    return_url: string;
    cancel_url: string;
  }>();

  const tenant = await c.env.WEB_DB
    .prepare("SELECT email FROM tenants WHERE tenant_id = ?")
    .bind(tenant_id)
    .first<{ email: string }>();

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  try {
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
    const customerId = await findOrCreateCustomer(stripe, tenant.email, tenant_id);

    const db = new SubscriptionDB(c.env.ADMIN_DB);
    await db.upsert(tenant_id, { stripe_customer_id: customerId });

    const priceMap: Record<string, string> = {
      basic: c.env.STRIPE_PRICE_BASIC,
      pro: c.env.STRIPE_PRICE_PRO,
    };
    const priceId = priceMap[tier];
    if (!priceId) {
      return c.json({ error: `Invalid tier: ${tier}` }, 400);
    }

    const approvalUrl = await createCheckoutSession(stripe, {
      customerId,
      tenantId: tenant_id,
      tier,
      priceId,
      returnUrl: return_url,
      cancelUrl: cancel_url,
    });

    return c.json({ approval_url: approvalUrl });
  } catch (err) {
    console.log(JSON.stringify({ error: "checkout_failed", detail: String(err) }));
    return c.json({ error: err instanceof Error ? err.message : "Checkout failed" }, 500);
  }
}
