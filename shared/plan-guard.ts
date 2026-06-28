import { TIERS, TIER_LIST, type Tier } from "./plans";

export interface PlanCheck {
  allowed: boolean;
  tier: Tier;
  requiredTier: Tier | null;
}

function findRequiredTier(check: (t: Tier) => boolean): Tier | null {
  for (const config of TIER_LIST) {
    if (check(config.tier)) return config.tier;
  }
  return null;
}

export function checkModuleAccess(tier: Tier, module: string): PlanCheck {
  const allowed = TIERS[tier]?.modules[module]?.enabled ?? true;
  return {
    allowed,
    tier,
    requiredTier: allowed ? null : findRequiredTier((t) => TIERS[t]?.modules[module]?.enabled === true),
  };
}

export function checkFeatureAccess(tier: Tier, feature: string): PlanCheck {
  const allowed = TIERS[tier]?.features[feature]?.enabled ?? true;
  return {
    allowed,
    tier,
    requiredTier: allowed ? null : findRequiredTier((t) => TIERS[t]?.features[feature]?.enabled === true),
  };
}

export function checkLimit(tier: Tier, key: string, currentCount: number): PlanCheck & { limit: number } {
  const limit = TIERS[tier]?.limits[key]?.value ?? -1;
  const allowed = limit === -1 || currentCount < limit;
  return {
    allowed,
    tier,
    limit,
    requiredTier: allowed ? null : findRequiredTier((t) => {
      const l = TIERS[t]?.limits[key]?.value ?? -1;
      return l === -1 || currentCount < l;
    }),
  };
}
