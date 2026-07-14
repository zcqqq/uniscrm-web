import { describe, it, expect } from "vitest";
import { formatPeriod } from "../../frontend/lib/format-period";

describe("formatPeriod", () => {
  it("formats a bare YYYY-MM-DD day-granularity period without a locale month name", () => {
    expect(formatPeriod("2026-06-04", "day", "UTC")).toBe("6/4");
  });

  it("formats an hour-granularity period as a date only, no time component (unchanged scope)", () => {
    expect(formatPeriod("2026-06-04T14:00:00.000Z", "hour", "UTC")).toBe("6/4");
  });

  it("formats a month-granularity period the same as day (existing behavior, format swap only)", () => {
    expect(formatPeriod("2026-06-01", "month", "UTC")).toBe("6/1");
  });

  it("formats a total-granularity period the same as day", () => {
    expect(formatPeriod("2026-06-04", "total", "UTC")).toBe("6/4");
  });

  it("compresses a same-month week range", () => {
    expect(formatPeriod("2026-06-08", "week", "UTC")).toBe("6/8-14");
  });

  it("expands a cross-month week range", () => {
    expect(formatPeriod("2026-06-29", "week", "UTC")).toBe("6/29-7/5");
  });

  it("leaves weekday-granularity values untouched (pre-existing, out-of-scope raw-digit fallback)", () => {
    expect(formatPeriod("3", "weekday", "UTC")).toBe("3");
  });

  it("returns an empty-ish fallback for a nullish period", () => {
    expect(formatPeriod(null, "day", "UTC")).toBe("");
  });
});
