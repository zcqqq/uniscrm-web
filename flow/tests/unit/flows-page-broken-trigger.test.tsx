import { describe, it, expect } from "vitest";
import { brokenTriggerTooltip } from "../../frontend/pages/FlowsPage";

describe("brokenTriggerTooltip", () => {
  it("names X for both X trigger types", () => {
    expect(brokenTriggerTooltip("xTrigger")).toContain("X account");
    expect(brokenTriggerTooltip("xContentTrigger")).toContain("X account");
  });

  it("names YouTube for the YouTube trigger", () => {
    expect(brokenTriggerTooltip("youtubeContentTrigger")).toContain("YouTube account");
  });

  it("falls back to a neutral noun for an unknown trigger type", () => {
    expect(brokenTriggerTooltip("somethingNew")).toContain("channel");
  });

  it("tells the user what to actually do about it", () => {
    expect(brokenTriggerTooltip("xTrigger")).toContain("Channels");
  });
});
