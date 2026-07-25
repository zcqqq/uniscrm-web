import { describe, it, expect } from "vitest";
import { canUseFeature, LOWEST_TIER } from "../../../shared/plans";

// link/src/oauth.ts's non-BYOK X connect gate (and link/frontend/components/SocialChannels.tsx's
// disabled-button state) both reduce to this single call — covering it here pins the actual
// tier rule (basic: link.x disabled, pro: unrestricted) that both call sites depend on.
describe("canUseFeature(tier, \"link.x\")", () => {
  it("basic tier cannot connect the official (non-BYOK) X channel", () => {
    expect(canUseFeature("basic", "link.x")).toBe(false);
  });

  it("basic tier can still use X BYOK", () => {
    expect(canUseFeature("basic", "link.x-byok")).toBe(true);
  });

  it("pro tier has no feature restrictions (empty features map defaults to allowed)", () => {
    expect(canUseFeature("pro", "link.x")).toBe(true);
  });

  // A tenant with no active subscription used to skip the gate entirely (`sub && ...`).
  // The connect callback now resolves an absent subscription to LOWEST_TIER, which must
  // land on the same "no official X channel" answer as an explicit basic plan.
  it("a tenant with no active subscription resolves to a tier that cannot connect official X", () => {
    expect(canUseFeature(LOWEST_TIER, "link.x")).toBe(false);
  });
});
