import type { Context } from "hono";
import type { Env } from "../types";
import { PLANS } from "../config/plans";

export async function plansRoute(c: Context<{ Bindings: Env }>) {
  const plans = PLANS.map(({ tier, name, price_monthly, currency }) => ({
    tier,
    name,
    price_monthly,
    currency,
  }));
  return c.json({ plans });
}
