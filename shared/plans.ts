export type Tier = "basic" | "pro";
export type SubStatus = "trialing" | "active" | "past_due" | "expired";

export interface ModuleEntry { enabled: boolean; description?: string }
export interface FeatureEntry { enabled: boolean; description?: string }
export interface LimitEntry { value: number; description?: string }

export interface TierConfig {
  tier: Tier;
  name: string;
  price_monthly: number;
  /** Monthly X-action credit allowance, in micros (1,000,000 micros = $1). Resets on the subscription's monthly anniversary. */
  monthly_credit_micros: number;
  modules: Record<string, ModuleEntry>;
  features: Record<string, FeatureEntry>;
  limits: Record<string, LimitEntry>;
}

export const TIERS: Record<Tier, TierConfig> = {
  basic: {
    tier: "basic",
    name: "Basic",
    price_monthly: 500,
    monthly_credit_micros: 5_000_000, // $5.00/month of X action credit
    modules: {
      "social.channels": { enabled: true, description: "Connect to your Twitter, TikTok, ... accounts" },
      "social.flow": { enabled: true, description: "Automation flows in control" },
      "social.users": { enabled: true, description: "Unlimited tracked users" },
      "social.lists": { enabled: false },
      profile: { enabled: false },
      content: { enabled: false },
      commerce: { enabled: false },
      insight: { enabled: true, description: "Unlimited analytics and dashboards" },
      settings: { enabled: true },
    },
    features: {
      "link.tiktok": { enabled: false },
    },
    limits: {
    },
  },
  pro: {
    tier: "pro",
    name: "Pro",
    price_monthly: 2000,
    monthly_credit_micros: 20_000_000, // $20.00/month of X action credit
    modules: {
    },
    features: {
    },
    limits: {
    },
  },
};

export const TIER_LIST: TierConfig[] = [TIERS.basic, TIERS.pro];

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
  if (config.monthly_credit_micros > 0) {
    descs.push(`$${(config.monthly_credit_micros / 1_000_000).toFixed(2)}/month of X action credit`);
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
