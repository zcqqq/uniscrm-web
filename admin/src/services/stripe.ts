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
    // 收银台语言。传 "auto"（或不传）时 Stripe 跟浏览器的 Accept-Language 走 —— 那是这里长期
    // 以来的行为，也正是它出的问题：中文浏览器看到中文收银台，付款没成被打回我们的英文
    // /billing 页，用户以为「页面变成英文了」（2026-08-20 租户 100005）。现在由调用方按
    // member 的语言指定，让收银台和产品页说同一种语言。
    locale?: Stripe.Checkout.SessionCreateParams.Locale;
  }
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    locale: params.locale ?? "auto",
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
