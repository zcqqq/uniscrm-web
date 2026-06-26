export type Tier = "pro" | "premium";
export type SubStatus = "trialing" | "active" | "past_due" | "expired";

export interface TierConfig {
  tier: Tier;
  name: string;
  price_monthly: number;
  descriptions: string[];
  modules: Record<string, boolean>;
  features: Record<string, boolean>;
  limits: Record<string, number>;
}

export const TIERS: Record<Tier, TierConfig> = {
  pro: {
    tier: "pro",
    name: "Pro",
    price_monthly: 500,
    descriptions: [
      "Flow automation (5 flows)",
      "3 linked channels",
      "Recommendations",
      "Content analytics",
      "10 lists",
      "5 segments",
    ],
    modules: {
      flow: true,
      link: true,
      "insight-analytics": true,
      "insight-segment": true,
      profile: false,
    },
    features: {
      "flow.waitForEvent": true,
      "flow.xAction": true,
      "profile.maigret": false,
      "link.tiktok": false,
    },
    limits: {
      flows: 5,
      channels: 3,
      lists: 10,
      segments: 5,
    },
  },
  premium: {
    tier: "premium",
    name: "Premium",
    price_monthly: 2000,
    descriptions: [
      "Unlimited flows & channels",
      "Profile & Maigret lookup",
      "TikTok integration",
      "Unlimited lists & segments",
      "Priority support",
      "API access",
    ],
    modules: {
      flow: true,
      link: true,
      "insight-analytics": true,
      "insight-segment": true,
      profile: true,
    },
    features: {
      "flow.waitForEvent": true,
      "flow.xAction": true,
      "profile.maigret": true,
      "link.tiktok": true,
    },
    limits: {
      flows: -1,
      channels: -1,
      lists: -1,
      segments: -1,
    },
  },
};

export const TIER_LIST: TierConfig[] = [TIERS.pro, TIERS.premium];

export function canAccessModule(tier: Tier, module: string): boolean {
  return TIERS[tier]?.modules[module] ?? false;
}

export function canUseFeature(tier: Tier, feature: string): boolean {
  return TIERS[tier]?.features[feature] ?? true;
}

export function getLimit(tier: Tier, key: string): number {
  return TIERS[tier]?.limits[key] ?? -1;
}

export function isActive(status: SubStatus): boolean {
  return status === "trialing" || status === "active";
}

export function getTierByPriceId(priceId: string, priceMap: Record<string, Tier>): TierConfig | undefined {
  const tier = priceMap[priceId];
  return tier ? TIERS[tier] : undefined;
}
