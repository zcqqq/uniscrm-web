import { describe, it, expect } from "vitest";
import { formatCompactDate, formatCompactWeekRange } from "../../frontend/lib/format-compact-date";

const NOW_2026 = new Date("2026-06-15T00:00:00.000Z");

describe("formatCompactDate", () => {
  it("formats 'none' (raw) with full time, this year", () => {
    expect(formatCompactDate("2026-06-04T14:23:45.000Z", "none", "UTC", NOW_2026)).toBe("6/4 14:23:45");
  });

  it("formats 'none' (raw) with full time, a past year", () => {
    expect(formatCompactDate("2025-06-04T14:23:45.000Z", "none", "UTC", NOW_2026)).toBe("25/6/4 14:23:45");
  });

  it("formats 'hour' with :00:00 seconds, this year", () => {
    expect(formatCompactDate("2026-06-04T14:00:00.000Z", "hour", "UTC", NOW_2026)).toBe("6/4 14:00:00");
  });

  it("formats 'hour' with :00:00 seconds, a past year", () => {
    expect(formatCompactDate("2025-06-04T14:00:00.000Z", "hour", "UTC", NOW_2026)).toBe("25/6/4 14:00:00");
  });

  it("formats 'day' with no time component, this year", () => {
    expect(formatCompactDate("2026-06-04T00:00:00.000Z", "day", "UTC", NOW_2026)).toBe("6/4");
  });

  it("formats 'day' with no time component, a past year", () => {
    expect(formatCompactDate("2025-06-04T00:00:00.000Z", "day", "UTC", NOW_2026)).toBe("25/6/4");
  });

  it("formats 'month' always with yy, this year", () => {
    expect(formatCompactDate("2026-06-01T00:00:00.000Z", "month", "UTC", NOW_2026)).toBe("26/6");
  });

  it("formats 'month' always with yy, a past year", () => {
    expect(formatCompactDate("2025-06-01T00:00:00.000Z", "month", "UTC", NOW_2026)).toBe("25/6");
  });

  it("formats 'quarter' always with yy and a Q-label, this year", () => {
    expect(formatCompactDate("2026-04-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q2");
  });

  it("formats 'quarter' always with yy and a Q-label, a past year", () => {
    expect(formatCompactDate("2025-04-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("25/Q2");
  });

  it("maps every month to the correct quarter boundary", () => {
    expect(formatCompactDate("2026-01-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q1");
    expect(formatCompactDate("2026-03-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q1");
    expect(formatCompactDate("2026-07-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q3");
    expect(formatCompactDate("2026-10-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q4");
    expect(formatCompactDate("2026-12-01T00:00:00.000Z", "quarter", "UTC", NOW_2026)).toBe("26/Q4");
  });

  it("respects the given IANA timezone when extracting calendar parts", () => {
    // 2026-06-04T23:30:00Z is already 2026-06-05 in Tokyo (UTC+9)
    expect(formatCompactDate("2026-06-04T23:30:00.000Z", "day", "Asia/Tokyo", NOW_2026)).toBe("6/5");
  });

  it("falls back to the raw input for an unparseable ISO string", () => {
    expect(formatCompactDate("not-a-date", "day", "UTC", NOW_2026)).toBe("not-a-date");
  });
});

describe("formatCompactWeekRange", () => {
  it("compresses a same-month week to M/D-D, this year", () => {
    // Monday 2026-06-08 through Sunday 2026-06-14
    expect(formatCompactWeekRange("2026-06-08T00:00:00.000Z", "UTC", NOW_2026)).toBe("6/8-14");
  });

  it("compresses a same-month week to yy/M/D-D, a past year", () => {
    expect(formatCompactWeekRange("2025-06-08T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/6/8-14");
  });

  it("expands a cross-month week to M/D-M/D, same year", () => {
    // Monday 2026-06-29 through Sunday 2026-07-05
    expect(formatCompactWeekRange("2026-06-29T00:00:00.000Z", "UTC", NOW_2026)).toBe("6/29-7/5");
  });

  it("expands a cross-month week to yy/M/D-M/D, a past year", () => {
    expect(formatCompactWeekRange("2025-06-29T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/6/29-7/5");
  });

  it("shows yy on both sides for a week crossing a year boundary", () => {
    // Monday 2025-12-30 through Sunday 2026-01-05
    expect(formatCompactWeekRange("2025-12-30T00:00:00.000Z", "UTC", NOW_2026)).toBe("25/12/30-26/1/5");
  });

  it("falls back to the raw input for an unparseable ISO string", () => {
    expect(formatCompactWeekRange("not-a-date", "UTC", NOW_2026)).toBe("not-a-date");
  });
});
