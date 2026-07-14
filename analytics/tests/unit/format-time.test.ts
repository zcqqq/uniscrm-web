import { describe, it, expect } from "vitest";
import { formatTime, formatDateTime } from "../../../shared/frontend/lib/format-time";

describe("formatTime / formatDateTime include seconds", () => {
  // 2026-01-02T03:04:05Z
  const iso = "2026-01-02T03:04:05.000Z";

  it("formatTime renders a seconds component, not just HH:MM", () => {
    const out = formatTime(iso, "UTC");
    expect(out).toMatch(/04:05/); // minute:second — hour isn't zero-padded in this locale
  });

  it("formatDateTime includes the seconds component too", () => {
    const out = formatDateTime(iso, "UTC");
    expect(out).toMatch(/04:05/);
  });

  it("respects the given IANA timezone", () => {
    const utc = formatTime(iso, "UTC");
    const tokyo = formatTime(iso, "Asia/Tokyo"); // UTC+9 -> 12:04:05
    expect(tokyo).toMatch(/12:04:05|12:04.*05/);
    expect(tokyo).not.toBe(utc);
  });
});
