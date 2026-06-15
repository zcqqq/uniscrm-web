export interface PlanConfig {
  tier: string;
  name: string;
  price_monthly: number;
  currency: string;
  stripe_price_id: string | null;
}

export const PLANS: PlanConfig[] = [
  { tier: "free", name: "Free", price_monthly: 0, currency: "usd", stripe_price_id: null },
  { tier: "pro", name: "Pro", price_monthly: 500, currency: "usd", stripe_price_id: "price_1TiW9PLhYonpsSAWQbGlYm9D" },
  { tier: "enterprise", name: "Enterprise", price_monthly: 2000, currency: "usd", stripe_price_id: "price_1TiW9sLhYonpsSAWeyyfaQUU" },
];

export function getPlanByTier(tier: string): PlanConfig | undefined {
  return PLANS.find((p) => p.tier === tier);
}

export function getPlanByPriceId(priceId: string): PlanConfig | undefined {
  return PLANS.find((p) => p.stripe_price_id === priceId);
}
