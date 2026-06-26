import type { Context } from "hono";
import type { Env } from "../types";
import { TIER_LIST } from "../../../shared/plans";

export async function plansRoute(c: Context<{ Bindings: Env }>) {
  const plans = TIER_LIST.map(({ tier, name, price_monthly }) => ({ tier, name, price_monthly, currency: "usd" }));
  return c.json({ plans });
}
