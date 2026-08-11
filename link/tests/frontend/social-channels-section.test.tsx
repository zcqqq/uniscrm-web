import { describe, it, expect } from "vitest";
import { SIMPLE_CHANNELS } from "../../frontend/lib/channelRegistry";
import { SOCIAL_SIMPLE_CHANNELS, CONTENT_SIMPLE_CHANNELS } from "../../frontend/components/SocialChannels";

// SocialChannels() maps SOCIAL_SIMPLE_CHANNELS and SimpleContentChannels() maps
// CONTENT_SIMPLE_CHANNELS with no further filtering — these arrays are exactly
// what each component renders, so asserting on the split is equivalent to
// asserting on render output without needing to mount React (this repo's
// vitest-pool-workers setup resolves "react" separately for link/ vs shared/,
// so cross-boundary component rendering hits a dual-React "Invalid hook call").

describe("SIMPLE_CHANNELS section split", () => {
  it("puts GitHub in the content section, not the social section", () => {
    expect(SOCIAL_SIMPLE_CHANNELS.some((c) => c.type === "GITHUB")).toBe(false);
    expect(CONTENT_SIMPLE_CHANNELS.some((c) => c.type === "GITHUB")).toBe(true);
  });

  it("defaults TikTok (no `section` set) to the social section", () => {
    const tiktok = SIMPLE_CHANNELS.find((c) => c.type === "TIKTOK");
    expect(tiktok?.section).toBeUndefined();
    expect(SOCIAL_SIMPLE_CHANNELS.some((c) => c.type === "TIKTOK")).toBe(true);
    expect(CONTENT_SIMPLE_CHANNELS.some((c) => c.type === "TIKTOK")).toBe(false);
  });

  it("puts GitHub first among the content-section channels", () => {
    expect(CONTENT_SIMPLE_CHANNELS[0]?.type).toBe("GITHUB");
  });

  it("partitions every SIMPLE_CHANNELS entry into exactly one section", () => {
    expect(SOCIAL_SIMPLE_CHANNELS.length + CONTENT_SIMPLE_CHANNELS.length).toBe(SIMPLE_CHANNELS.length);
    const social = new Set(SOCIAL_SIMPLE_CHANNELS.map((c) => c.type));
    const content = new Set(CONTENT_SIMPLE_CHANNELS.map((c) => c.type));
    for (const cfg of SIMPLE_CHANNELS) {
      expect(social.has(cfg.type) !== content.has(cfg.type)).toBe(true);
    }
  });
});
