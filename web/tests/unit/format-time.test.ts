import { describe, it, expect } from "vitest";
import { formatDate, formatTime, formatDateTime } from "../../../shared/frontend/lib/format-time";

// The unified display format: date M/D/YYYY (fixed across UI languages),
// time HH:MM:SS 24-hour, both converted to the member's timezone.
describe("format-time", () => {
  const iso = "2026-07-24T06:03:05.000Z";

  it("formats the date as M/D/YYYY in the given timezone", () => {
    expect(formatDate(iso, "UTC")).toBe("7/24/2026");
    expect(formatDate(iso, "Asia/Shanghai")).toBe("7/24/2026");
    // UTC-8: still the previous day
    expect(formatDate(iso, "America/Los_Angeles")).toBe("7/23/2026");
  });

  it("formats the time as 24h HH:MM:SS in the given timezone", () => {
    expect(formatTime(iso, "UTC")).toBe("06:03:05");
    expect(formatTime(iso, "Asia/Shanghai")).toBe("14:03:05");
  });

  it("uses h23 midnight (00, never 24)", () => {
    expect(formatTime("2026-07-24T00:00:00.000Z", "UTC")).toBe("00:00:00");
  });

  it("normalizes SQLite datetime('now') space-separated UTC strings", () => {
    expect(formatDateTime("2026-07-24 06:03:05", "Asia/Shanghai")).toBe("7/24/2026 14:03:05");
  });

  it("returns the raw string for unparseable input", () => {
    expect(formatDate("not-a-date", "UTC")).toBe("not-a-date");
    expect(formatTime("not-a-date", "UTC")).toBe("not-a-date");
  });

  it("formatDateTime joins date and time with a space", () => {
    expect(formatDateTime(iso, "UTC")).toBe("7/24/2026 06:03:05");
  });
});
