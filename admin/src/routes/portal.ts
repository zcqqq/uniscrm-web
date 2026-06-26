import type { Context } from "hono";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";
import { createStripeClient, createPortalSession } from "../services/stripe";

export async function portalRoute(c: Context<{ Bindings: Env }>) {
  const { tenant_id, return_url } = await c.req.json<{
    tenant_id: string;
    return_url: string;
  }>();

  const db = new SubscriptionDB(c.env.ADMIN_DB);
  const row = await db.getByTenantId(tenant_id);

  if (!row?.stripe_customer_id) {
    return c.json({ error: "No billing account found" }, 400);
  }

  try {
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
    const portalUrl = await createPortalSession(stripe, row.stripe_customer_id, return_url);

    return c.json({ portal_url: portalUrl });
  } catch (err) {
    console.log(JSON.stringify({ error: "portal_failed", detail: String(err) }));
    return c.json({ error: err instanceof Error ? err.message : "Portal session failed" }, 500);
  }
}
