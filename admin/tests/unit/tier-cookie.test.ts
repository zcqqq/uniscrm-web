import { describe, it, expect } from "vitest";
import { LOWEST_TIER, parseTierCookie, TIERS } from "../../../shared/plans";

// The `tier` cookie is a non-httpOnly display hint written at login and refreshed on the
// Billing page. Anything the frontend can't recognize in it must fall back to the cheapest
// plan, because the previous "undefined tier" path unlocked every gated menu and route.
describe("parseTierCookie", () => {
  it("reads a recognized tier out of a full cookie string", () => {
    expect(parseTierCookie("session=abc; tier=pro; lang=en")).toBe("pro");
    expect(parseTierCookie("tier=basic")).toBe("basic");
  });

  it("falls back to the lowest tier when the cookie is absent", () => {
    expect(parseTierCookie("session=abc; lang=en")).toBe(LOWEST_TIER);
    expect(parseTierCookie("")).toBe(LOWEST_TIER);
  });

  it("falls back to the lowest tier for unrecognized values, including the DB default 'free'", () => {
    expect(parseTierCookie("tier=free")).toBe(LOWEST_TIER);
    expect(parseTierCookie("tier=enterprise")).toBe(LOWEST_TIER);
    expect(parseTierCookie("tier=")).toBe(LOWEST_TIER);
  });

  it("does not match a cookie whose name merely ends in 'tier'", () => {
    expect(parseTierCookie("subtier=pro")).toBe(LOWEST_TIER);
  });
});

describe("LOWEST_TIER", () => {
  it("is a real tier with a restrictive module map, so falling back to it actually gates", () => {
    expect(TIERS[LOWEST_TIER]).toBeDefined();
    expect(Object.values(TIERS[LOWEST_TIER].modules).some((m) => !m.enabled)).toBe(true);
  });
});
