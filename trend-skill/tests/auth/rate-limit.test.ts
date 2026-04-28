import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../../src/auth/rate-limit";

const makeKvMock = () => {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as KVNamespace;
};

describe("RateLimiter", () => {
  let kv: KVNamespace;
  let limiter: RateLimiter;

  beforeEach(() => {
    kv = makeKvMock();
    limiter = new RateLimiter(kv);
  });

  it("allows first request", async () => {
    const result = await limiter.check("user1", "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("blocks after limit exceeded", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.check("user2", "anonymous");
    }
    const result = await limiter.check("user2", "anonymous");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("uses tier-specific limits", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.check("user3", "free");
    }
    const result = await limiter.check("user3", "free");
    expect(result.allowed).toBe(true);
  });
});
