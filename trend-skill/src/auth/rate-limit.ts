import type { Tier } from "../types";

export const RATE_LIMITS: Record<"anonymous" | Tier, number> = {
  anonymous: 10,
  free: 30,
  premium: 300,
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export class RateLimiter {
  constructor(private kv: KVNamespace) {}

  async check(identifier: string, tier: "anonymous" | Tier): Promise<RateLimitResult> {
    const hourBucket = Math.floor(Date.now() / 3600000);
    const kvKey = `ratelimit:${identifier}:${hourBucket}`;
    const limit = RATE_LIMITS[tier];

    const current = parseInt((await this.kv.get(kvKey)) ?? "0", 10);

    if (current >= limit) {
      const secondsUntilReset = 3600 - Math.floor((Date.now() % 3600000) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds: secondsUntilReset };
    }

    await this.kv.put(kvKey, String(current + 1), { expirationTtl: 3600 });
    return { allowed: true, remaining: limit - current - 1 };
  }
}
