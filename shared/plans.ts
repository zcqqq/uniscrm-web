import type { LocalizedString } from "../metadata/dataTypes";

export type Tier = "basic" | "pro";
export type SubStatus = "trialing" | "active" | "past_due" | "expired";

export interface ModuleEntry { enabled: boolean; description?: LocalizedString; isHeader?: boolean }
export interface FeatureEntry { enabled: boolean; description?: LocalizedString; isHeader?: boolean }
export interface LimitEntry { value: number; description?: LocalizedString; isHeader?: boolean }

export interface TierConfig {
  tier: Tier;
  name: LocalizedString;
  price_monthly: number;
  modules: Record<string, ModuleEntry>;
  features: Record<string, FeatureEntry>;
  limits: Record<string, LimitEntry>;
}

export const TIERS: Record<Tier, TierConfig> = {
  basic: {
    tier: "basic",
    name: { en: "Basic", zh: "基础版" },
    price_monthly: 2000,
    modules: {
      "social.channels": { enabled: true, description: { en: "Connect to your Twitter, TikTok, ... accounts", zh: "连接你的 Twitter、TikTok 等账号" } },
      "social.flow": { enabled: true, description: { en: "Automation flows in control", zh: "自动化流程尽在掌握" } },
      "social.users": { enabled: true, description: { en: "Unlimited tracked users", zh: "不限量的用户追踪" } },
      "social.lists": { enabled: false },
      profile: { enabled: false },
      "content.content": { enabled: true, description: { en: "Contents from social channels and content libraries", zh: "来自社交渠道与内容库的内容" } },
      "content.recommendations": { enabled: false },
      commerce: { enabled: false },
      insight: { enabled: true, description: { en: "Unlimited analytics and dashboards", zh: "不限量的分析与仪表盘" } },
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
    name: { en: "Pro", zh: "专业版" },
    price_monthly: 10000,
    modules: {
      // Not a real module -- a header row for the plan comparison list, marking that Pro
      // includes everything Basic has. TIER_LIST is [basic] so this always reads "All in
      // Basic Plan, plus:"; Billing.tsx renders it via isHeader instead of sniffing the text.
      "_tier.header": { enabled: true, description: { en: "All in Basic Plan, plus:", zh: "基础版全部功能，另加：" }, isHeader: true },
    },
    features: {
      "link.x": { enabled: true },
    },
    limits: {
      credit: { value: 100_000_000, description: { en: "$100.00/month of credit (for X paid APIs)", zh: "每月 $100.00 额度（用于 X 付费 API）" } },
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

export interface TierDescription {
  text: LocalizedString;
  isHeader: boolean;
}

export function getTierDescriptions(tier: Tier): TierDescription[] {
  const config = TIERS[tier];
  if (!config) return [];
  const descs: TierDescription[] = [];
  for (const entry of Object.values(config.modules)) {
    if (entry.description) descs.push({ text: entry.description, isHeader: !!entry.isHeader });
  }
  for (const entry of Object.values(config.features)) {
    if (entry.description) descs.push({ text: entry.description, isHeader: !!entry.isHeader });
  }
  for (const entry of Object.values(config.limits)) {
    if (entry.description) descs.push({ text: entry.description, isHeader: !!entry.isHeader });
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
