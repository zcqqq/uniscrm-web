import { describe, it, expect } from "vitest";
import { computeTrialEndTs, assertSafeId, assertTenantId } from "./comp-tenant-pro.ts";

describe("computeTrialEndTs", () => {
  it("floors to UTC midnight and never exceeds the 730-day cap", () => {
    const now = new Date("2026-08-06T05:06:00Z");
    const ts = computeTrialEndTs(now);
    const capTs = Math.floor((now.getTime() + 730 * 86400_000) / 1000);
    expect(ts).toBeLessThanOrEqual(capTs); // 超过上限 Stripe 会直接拒绝，floor 保证不越界
    expect(ts % 86400).toBe(0); // UTC 整日
    expect(new Date(ts * 1000).toISOString()).toBe("2028-08-05T00:00:00.000Z");
  });

  it("stays within cap even when called at exactly midnight", () => {
    const now = new Date("2026-08-06T00:00:00Z");
    const ts = computeTrialEndTs(now);
    expect(ts).toBe(Math.floor((now.getTime() + 730 * 86400_000) / 1000));
  });
});

describe("assertSafeId", () => {
  it("accepts Stripe-shaped ids", () => {
    expect(assertSafeId("sub_1U1JVvQvNSxtC12sPFrjLboO", "sub")).toBe("sub_1U1JVvQvNSxtC12sPFrjLboO");
    expect(assertSafeId("cus_V1MEuzRLLGrG2l", "cus")).toBe("cus_V1MEuzRLLGrG2l");
  });

  it("rejects anything that could break out of the SQL string literal", () => {
    // 这些值会被拼进 wrangler d1 execute 的 SQL（无参数绑定），引号必须进不来
    for (const bad of ["x'; DROP TABLE subscriptions;--", "a b", "id\"", ""]) {
      expect(() => assertSafeId(bad, "id")).toThrow();
    }
  });
});

describe("assertTenantId", () => {
  it("accepts positive integers", () => {
    expect(assertTenantId("100003")).toBe(100003);
  });

  it("rejects non-integers, negatives, and SQL-injectable strings", () => {
    for (const bad of [undefined, "abc", "-1", "0", "1.5", "1 OR 1=1"]) {
      expect(() => assertTenantId(bad)).toThrow();
    }
  });
});
