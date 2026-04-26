import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter, RATE_LIMITS } from "../../src/auth/rate-limit";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  } as unknown as KVNamespace;
}

describe("RateLimiter", () => {
  let kv: KVNamespace;
  let limiter: RateLimiter;

  beforeEach(() => {
    kv = createMockKV();
    limiter = new RateLimiter(kv);
  });

  it("allows requests under the limit", async () => {
    const result = await limiter.check("test-key", "free");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMITS.free - 1);
  });

  it("blocks requests over the limit", async () => {
    for (let i = 0; i < RATE_LIMITS.free; i++) {
      await limiter.check("test-key", "free");
    }
    const result = await limiter.check("test-key", "free");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("tracks different keys independently", async () => {
    for (let i = 0; i < RATE_LIMITS.free; i++) {
      await limiter.check("key-a", "free");
    }
    const resultA = await limiter.check("key-a", "free");
    const resultB = await limiter.check("key-b", "free");
    expect(resultA.allowed).toBe(false);
    expect(resultB.allowed).toBe(true);
  });

  it("uses correct limits per tier", () => {
    expect(RATE_LIMITS.anonymous).toBe(10);
    expect(RATE_LIMITS.free).toBe(30);
    expect(RATE_LIMITS.premium).toBe(300);
  });
});
