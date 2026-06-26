import type { Context } from "hono";
import type { Env } from "../types";
import { SubscriptionDB } from "../services/subscription-db";

export async function activateTrialRoute(c: Context<{ Bindings: Env }>) {
  const { tenant_id, tier, days } = await c.req.json<{
    tenant_id: number;
    tier: string;
    days: number;
  }>();

  const db = new SubscriptionDB(c.env.ADMIN_DB);
  const existing = await db.getByTenantId(String(tenant_id));

  if (existing?.stripe_subscription_id) {
    return c.json({ ok: false, reason: "already_paid" });
  }

  if (existing?.status === "trialing" && existing.current_period_end) {
    const endsAt = new Date(existing.current_period_end);
    if (endsAt > new Date()) {
      return c.json({ ok: false, reason: "trial_active", current_period_end: existing.current_period_end });
    }
  }

  const periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  await db.upsert(String(tenant_id), {
    tier,
    status: "trialing",
    current_period_end: periodEnd,
    cancel_at_period_end: 0,
  });

  return c.json({ ok: true, current_period_end: periodEnd });
}
