import Stripe from "stripe";

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

export async function findOrCreateCustomer(
  stripe: Stripe,
  email: string,
  tenantId: string
): Promise<string> {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    return existing.data[0].id;
  }
  const customer = await stripe.customers.create({
    email,
    metadata: { tenant_id: tenantId },
  });
  return customer.id;
}

export async function createCheckoutSession(
  stripe: Stripe,
  params: {
    customerId: string;
    tenantId: string;
    tier: string;
    priceId: string;
    returnUrl: string;
    cancelUrl: string;
  }
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: `${params.returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: params.cancelUrl,
    subscription_data: {
      metadata: { tenant_id: params.tenantId, tier: params.tier },
    },
    metadata: { tenant_id: params.tenantId, tier: params.tier },
  });

  if (!session.url) {
    throw new Error("Checkout session URL not available");
  }
  return session.url;
}

export async function createPortalSession(
  stripe: Stripe,
  customerId: string,
  returnUrl: string
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

export async function cancelSubscription(
  stripe: Stripe,
  subscriptionId: string
): Promise<void> {
  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}
