export type Tier = "basic" | "pro";
export type SubStatus = "trialing" | "active" | "past_due" | "expired";

export interface ModuleEntry { enabled: boolean; description?: string }
export interface FeatureEntry { enabled: boolean; description?: string }
export interface LimitEntry { value: number; description?: string }

export interface TierConfig {
  tier: Tier;
  name: string;
  price_monthly: number;
  modules: Record<string, ModuleEntry>;
  features: Record<string, FeatureEntry>;
  limits: Record<string, LimitEntry>;
}

export const TIERS: Record<Tier, TierConfig> = {
  basic: {
    tier: "basic",
    name: "Basic",
    price_monthly: 2000,
    modules: {
      "social.channels": { enabled: true, description: "Connect to your Twitter, TikTok, ... accounts" },
      "social.flow": { enabled: true, description: "Automation flows in control" },
      "social.users": { enabled: true, description: "Unlimited tracked users" },
      "social.lists": { enabled: false },
      profile: { enabled: false },
      "content.content": { enabled: true, description: "Contents from social channels and content libraries" },
      "content.recommendations": { enabled: false },
      commerce: { enabled: false },
      insight: { enabled: true, description: "Unlimited analytics and dashboards" },
      settings: { enabled: true },
    },
    features: {
      "link.x": { enabled: false },
      "link.x-byok": { enabled: true },
      "link.tiktok": { enabled: true },
    },
    limits: {
      // Monthly X-action credit allowance, in micros (1,000,000 micros = $1). Resets on the
      // subscription's monthly anniversary. See shared/credit.ts and shared/credit-service.ts.
      // 用6位小数是业界标准
      //credit: { value: 20_000_000, description: "$20.00/month of credit (for X paid APIs)" },
    },
  },
  pro: {
    tier: "pro",
    name: "Pro",
    price_monthly: 10000,
    modules: {
    },
    features: {
      "link.x": { enabled: true },
    },
    limits: {
      credit: { value: 100_000_000, description: "$100.00/month of credit (for X paid APIs)" },
    },
  },
};

export const TIER_LIST: TierConfig[] = [TIERS.basic];

// The gating floor. Whenever a tenant's tier can't be determined — no subscription row, an
// expired one, an unrecognized tier string (the DB column still defaults to 'free'), or a
// lookup that threw — callers fall back to this instead of granting access outright.
// TIER_LIST is ordered cheapest-first; findRequiredTier below relies on the same ordering.
export const LOWEST_TIER: Tier = TIER_LIST[0].tier;

// The `tier` cookie is written at login (web/worker/api/auth.ts) and refreshed with the real
// subscription tier on the Billing page. It is a non-httpOnly display hint, so an absent or
// unrecognized value must fail closed — returning "no tier" used to unlock every gated menu.
export function parseTierCookie(cookie: string): Tier {
  const value = cookie.match(/(?:^|;\s*)tier=([^;]*)/)?.[1];
  return value === "basic" || value === "pro" ? value : LOWEST_TIER;
}

export function canAccessModule(tier: Tier, module: string): boolean {
  return TIERS[tier]?.modules[module]?.enabled ?? true;
}

export function canUseFeature(tier: Tier, feature: string): boolean {
  return TIERS[tier]?.features[feature]?.enabled ?? true;
}

export function getLimit(tier: Tier, key: string): number {
  return TIERS[tier]?.limits[key]?.value ?? -1;
}

export function getTierDescriptions(tier: Tier): string[] {
  const config = TIERS[tier];
  if (!config) return [];
  const descs: string[] = [];
  const tierIndex = TIER_LIST.findIndex((t) => t.tier === tier);
  if (tierIndex > 0) {
    descs.push(`All in ${TIER_LIST[tierIndex - 1].name} Plan, plus:`);
  }
  for (const entry of Object.values(config.modules)) {
    if (entry.description) descs.push(entry.description);
  }
  for (const entry of Object.values(config.features)) {
    if (entry.description) descs.push(entry.description);
  }
  for (const entry of Object.values(config.limits)) {
    if (entry.description) descs.push(entry.description);
  }
  return descs;
}

export function isActive(status: SubStatus): boolean {
  return status === "trialing" || status === "active";
}

export function getTierByPriceId(priceId: string, priceMap: Record<string, Tier>): TierConfig | undefined {
  const tier = priceMap[priceId];
  return tier ? TIERS[tier] : undefined;
}
