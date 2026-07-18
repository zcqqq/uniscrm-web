import { describe, it, expect } from "vitest";
import { getCreditPeriod, dollarsToMicros, microsToDollars, formatUsd } from "../../../shared/credit";

describe("credit period anniversary logic", () => {
  it("keeps the anchor day when every month is long enough", () => {
    const anchor = "2026-03-15T08:00:00.000Z";
    const { start, end } = getCreditPeriod(anchor, new Date("2026-04-20T00:00:00Z"));
    expect(start.toISOString()).toBe("2026-04-15T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-15T08:00:00.000Z");
  });

  it("clamps Jan 31 -> Feb 28, then jumps back to 31 in March", () => {
    const anchor = "2026-01-31T10:00:00.000Z";

    const feb = getCreditPeriod(anchor, new Date("2026-02-15T00:00:00Z"));
    expect(feb.start.toISOString()).toBe("2026-01-31T10:00:00.000Z");
    expect(feb.end.toISOString()).toBe("2026-02-28T10:00:00.000Z");

    const mar = getCreditPeriod(anchor, new Date("2026-03-15T00:00:00Z"));
    expect(mar.start.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(mar.end.toISOString()).toBe("2026-03-31T10:00:00.000Z");

    const apr = getCreditPeriod(anchor, new Date("2026-04-15T00:00:00Z"));
    expect(apr.start.toISOString()).toBe("2026-03-31T10:00:00.000Z");
    expect(apr.end.toISOString()).toBe("2026-04-30T10:00:00.000Z");
  });

  it("handles a leap-year February correctly (2028 anchor day 31)", () => {
    const anchor = "2028-01-31T00:00:00.000Z";
    const feb = getCreditPeriod(anchor, new Date("2028-02-20T00:00:00Z"));
    expect(feb.end.toISOString()).toBe("2028-02-29T00:00:00.000Z"); // 2028 is a leap year
  });

  it("is stable exactly at a period boundary (inclusive start, exclusive end)", () => {
    const anchor = "2026-01-31T10:00:00.000Z";
    const { start, end } = getCreditPeriod(anchor, new Date("2026-02-28T10:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-31T10:00:00.000Z");
  });
});

describe("dollar/micros conversion", () => {
  it("converts fractional-cent X action prices to exact integer micros", () => {
    expect(dollarsToMicros(0.015)).toBe(15_000);
    expect(dollarsToMicros(0.01)).toBe(10_000);
    expect(dollarsToMicros(5)).toBe(5_000_000);
  });

  it("round-trips without floating point drift", () => {
    expect(microsToDollars(dollarsToMicros(0.015))).toBeCloseTo(0.015, 6);
  });
});

describe("formatUsd", () => {
  it("formats a dollar amount to 3 decimal places with a $ prefix", () => {
    expect(formatUsd(0.015)).toBe("$0.015");
    expect(formatUsd(0.01)).toBe("$0.010");
    expect(formatUsd(0.001)).toBe("$0.001");
    expect(formatUsd(5)).toBe("$5.000");
  });
});
