import { describe, it, expect } from "vitest";
import { themeCookieString } from "../../../shared/frontend/theme";

describe("themeCookieString", () => {
  it("builds the shared cross-subdomain cookie string for each theme value", () => {
    expect(themeCookieString("light")).toBe(
      "theme=light; path=/; max-age=31536000; secure; samesite=lax; domain=uni-scrm.com"
    );
    expect(themeCookieString("dark")).toBe(
      "theme=dark; path=/; max-age=31536000; secure; samesite=lax; domain=uni-scrm.com"
    );
    expect(themeCookieString("system")).toBe(
      "theme=system; path=/; max-age=31536000; secure; samesite=lax; domain=uni-scrm.com"
    );
  });
});
