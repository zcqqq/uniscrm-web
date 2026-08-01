import { describe, it, expect } from "vitest";
import { subscriptionSummary, toggleSubscription } from "../../frontend/lib/subscription-summary";
import { multiSelectSummary } from "../../../shared/frontend/lib/multi-select-summary";

describe("subscriptionSummary", () => {
  it("0 subscriptions", () => {
    expect(subscriptionSummary([])).toBe("(no subscription selected)");
  });
  it("1 subscription shows its name", () => {
    expect(subscriptionSummary([{ channelId: "UCa", channelName: "MKBHD" }])).toBe("MKBHD");
  });
  it("falls back to channelId when name is empty", () => {
    expect(subscriptionSummary([{ channelId: "UCa", channelName: "" }])).toBe("UCa");
  });
  it("N subscriptions shows first +N-1", () => {
    expect(subscriptionSummary([
      { channelId: "UCa", channelName: "MKBHD" },
      { channelId: "UCb", channelName: "Veritasium" },
      { channelId: "UCc", channelName: "Kurzgesagt" },
    ])).toBe("MKBHD +2");
  });
});

describe("toggleSubscription", () => {
  const a = { channelId: "UCa", channelName: "A" };
  const b = { channelId: "UCb", channelName: "B" };
  it("adds an unselected subscription at the end", () => {
    expect(toggleSubscription([a], b)).toEqual([a, b]);
  });
  it("removes an already-selected subscription (matched by channelId)", () => {
    expect(toggleSubscription([a, b], { channelId: "UCa", channelName: "stale name" })).toEqual([b]);
  });
  it("does not mutate the input array", () => {
    const current = [a];
    toggleSubscription(current, b);
    expect(current).toEqual([a]);
  });
});

describe("multiSelectSummary", () => {
  it("empty selection shows placeholder", () => {
    expect(multiSelectSummary([], "Select subscriptions...")).toBe("Select subscriptions...");
  });
  it("single selection shows the label", () => {
    expect(multiSelectSummary(["MKBHD"], "x")).toBe("MKBHD");
  });
  it("multiple selections show first +N more", () => {
    expect(multiSelectSummary(["MKBHD", "Veritasium", "Kurzgesagt"], "x")).toBe("MKBHD +2 more");
  });
});
