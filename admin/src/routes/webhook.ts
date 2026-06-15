import type { Context } from "hono";
import Stripe from "stripe";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";
import { getPlanByPriceId } from "../config/plans";

export async function webhookRoute(c: Context<{ Bindings: Env }>) {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ error: "Missing signature" }, 400);
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("Webhook signature verification failed", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  console.log(JSON.stringify({ webhook_event: event.type, event_id: event.id }));

  const db = new SubscriptionDB(c.env.DB);

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(db, event.data.object as Stripe.Checkout.Session, stripe);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(db, event.data.object as Stripe.Subscription);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(db, event.data.object as Stripe.Subscription);
      break;
    case "invoice.payment_failed":
      await handlePaymentFailed(db, event.data.object as Stripe.Invoice);
      break;
  }

  return c.json({ received: true });
}

async function handleCheckoutCompleted(
  db: SubscriptionDB,
  session: Stripe.Checkout.Session,
  stripe: Stripe
) {
  const tenantId = session.metadata?.tenant_id;
  const tier = session.metadata?.tier;
  if (!tenantId || !tier) return;

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();

  await db.upsert(tenantId, {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    tier,
    status: "active",
    current_period_end: periodEnd,
    cancel_at_period_end: 0,
  });
}

async function handleSubscriptionUpdated(db: SubscriptionDB, subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price?.id;
  const plan = priceId ? getPlanByPriceId(priceId) : null;

  await db.updateByStripeSubscriptionId(subscription.id, {
    tier: plan?.tier ?? "pro",
    status: subscription.status,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
  });
}

async function handleSubscriptionDeleted(db: SubscriptionDB, subscription: Stripe.Subscription) {
  await db.updateByStripeSubscriptionId(subscription.id, {
    tier: "free",
    status: "canceled",
    stripe_subscription_id: null,
    current_period_end: null,
    cancel_at_period_end: 0,
  });
}

async function handlePaymentFailed(db: SubscriptionDB, invoice: Stripe.Invoice) {
  const subId = invoice.subscription as string | null;
  if (!subId) return;

  await db.updateByStripeSubscriptionId(subId, {
    status: "past_due",
  });
}
