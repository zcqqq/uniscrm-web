import type { Tier, RateLimitResult } from "../types";
import { TIER_RATE_LIMITS } from "../types";

export class RateLimiter {
  constructor(private kv: KVNamespace) {}

  async check(identifier: string, tier: Tier): Promise<RateLimitResult> {
    const limit = TIER_RATE_LIMITS[tier];
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `ratelimit:${identifier}:${hourBucket}`;

    const current = parseInt((await this.kv.get(key)) ?? "0", 10);

    if (current >= limit) {
      const secondsIntoHour = Math.floor((Date.now() % 3_600_000) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 3600 - secondsIntoHour,
      };
    }

    await this.kv.put(key, String(current + 1), { expirationTtl: 3600 });
    return {
      allowed: true,
      remaining: limit - current - 1,
    };
  }
}
