import { describe, it, expect } from "vitest";
import { COMMON_TIMEZONES, getTimezoneLabel, timezoneOptions } from "../../src/lib/timezones";

describe("timezoneOptions", () => {
  it("returns the shortlist unchanged when the member's zone is already in it", () => {
    expect(timezoneOptions("Asia/Shanghai")).toEqual(COMMON_TIMEZONES);
    expect(timezoneOptions("UTC")).toEqual(COMMON_TIMEZONES);
  });

  // Without this the <select> value matches no <option>, the browser renders the first entry
  // ("UTC"), and the member is shown a timezone they never chose.
  it("prepends the member's zone when the shortlist does not cover it", () => {
    const options = timezoneOptions("Europe/Amsterdam");
    expect(options[0]).toBe("Europe/Amsterdam");
    expect(options).toHaveLength(COMMON_TIMEZONES.length + 1);
    expect(new Set(options).size).toBe(options.length);
  });

  it("returns the shortlist when the member has no zone yet", () => {
    expect(timezoneOptions(undefined)).toEqual(COMMON_TIMEZONES);
  });
});

describe("getTimezoneLabel", () => {
  it("renders the zone with its UTC offset", () => {
    expect(getTimezoneLabel("Asia/Shanghai")).toBe("Asia/Shanghai (UTC+8)");
  });

  it("underscores become spaces", () => {
    expect(getTimezoneLabel("America/New_York")).toMatch(/^America\/New York \(UTC-\d\)$/);
  });

  it("falls back to the bare name for a zone Intl rejects", () => {
    expect(getTimezoneLabel("Mars/Olympus")).toBe("Mars/Olympus");
  });
});
