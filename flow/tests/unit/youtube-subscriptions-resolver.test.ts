import { describe, it, expect } from "vitest";
import { resolveYouTubeSubscriptions } from "../../nodeTypeRegistry";

describe("resolveYouTubeSubscriptions", () => {
  it("returns [] for undefined / null / non-object data", () => {
    expect(resolveYouTubeSubscriptions(undefined)).toEqual([]);
    expect(resolveYouTubeSubscriptions(null)).toEqual([]);
  });

  it("uses the subscriptions array when present", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }] })
    ).toEqual([{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }]);
  });

  it("empty array means explicitly cleared — no fallback to legacy scalars", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [], subscriptionChannelId: "UCa", subscriptionChannelName: "A" })
    ).toEqual([]);
  });

  it("array takes precedence over legacy scalars when both present", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCnew", channelName: "New" }], subscriptionChannelId: "UCold", subscriptionChannelName: "Old" })
    ).toEqual([{ channelId: "UCnew", channelName: "New" }]);
  });

  it("filters malformed array elements without throwing", () => {
    expect(
      resolveYouTubeSubscriptions({
        subscriptions: [null, "str", 42, { channelName: "no id" }, { channelId: "" }, { channelId: 123 }, { channelId: "UCok" }],
      })
    ).toEqual([{ channelId: "UCok", channelName: "" }]);
  });

  it("defaults missing / non-string channelName to empty string", () => {
    expect(resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCa", channelName: { x: 1 } }] }))
      .toEqual([{ channelId: "UCa", channelName: "" }]);
  });

  it("falls back to legacy scalar pair as a single-element array", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "UCa", subscriptionChannelName: "A" }))
      .toEqual([{ channelId: "UCa", channelName: "A" }]);
  });

  it("legacy scalar with missing name yields empty channelName", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "UCa" }))
      .toEqual([{ channelId: "UCa", channelName: "" }]);
  });

  it("legacy empty or non-string subscriptionChannelId yields []", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "" })).toEqual([]);
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: { evil: true } })).toEqual([]);
    expect(resolveYouTubeSubscriptions({})).toEqual([]);
  });
});
