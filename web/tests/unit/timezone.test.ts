import { describe, it, expect } from "vitest";
import { isValidTimezone, resolveSignupTimezone } from "../../worker/services/timezone";

describe("isValidTimezone", () => {
  it("accepts IANA zone names", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects anything Intl cannot resolve", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("UTC+8")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

// Signup writes members.timezone once and the member rarely revisits Settings, so the value
// picked here is what every timestamp in the product renders in. Order of trust:
// the browser's own Intl zone > Cloudflare's IP-derived zone > UTC.
describe("resolveSignupTimezone", () => {
  it("prefers the zone the browser reported", () => {
    expect(resolveSignupTimezone("Asia/Shanghai", "Europe/London")).toBe("Asia/Shanghai");
  });

  it("falls back to the Cloudflare IP zone when the browser sent nothing", () => {
    expect(resolveSignupTimezone(undefined, "Europe/London")).toBe("Europe/London");
    expect(resolveSignupTimezone(null, "Europe/London")).toBe("Europe/London");
    expect(resolveSignupTimezone("", "Europe/London")).toBe("Europe/London");
  });

  // The browser value arrives as a query param / JSON body, so it is untrusted input written
  // straight into a NOT NULL column — a junk value must not poison every later render.
  it("falls back to the Cloudflare IP zone when the browser value is not a real zone", () => {
    expect(resolveSignupTimezone("'; DROP TABLE members; --", "Europe/London")).toBe("Europe/London");
  });

  it("returns UTC when neither signal is usable", () => {
    expect(resolveSignupTimezone(undefined, undefined)).toBe("UTC");
    expect(resolveSignupTimezone("Mars/Olympus", "Mars/Phobos")).toBe("UTC");
  });
});
