import { describe, it, expect } from "vitest";
import { getNodeIcon } from "../../frontend/pages/FlowsPage";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";

describe("getNodeIcon", () => {
  it("maps xContentTrigger to XIcon, not a generic document icon", () => {
    expect(getNodeIcon("xContentTrigger", {})).toBe(XIcon);
  });

  it("maps youtubeContentTrigger to YouTubeIcon", () => {
    expect(getNodeIcon("youtubeContentTrigger", {})).toBe(YouTubeIcon);
  });

  it("maps xContentAction to XIcon, not a generic document icon", () => {
    expect(getNodeIcon("action", { actionType: "xContentAction" })).toBe(XIcon);
  });

  it("maps tiktokContentAction to TikTokIcon, not a generic document icon", () => {
    expect(getNodeIcon("action", { actionType: "tiktokContentAction" })).toBe(TikTokIcon);
  });

  it("does not mislabel videoAction with the X icon", () => {
    expect(getNodeIcon("action", { actionType: "videoAction" })).not.toBe(XIcon);
  });

  it("still maps xAction (the only remaining action default) to XIcon", () => {
    expect(getNodeIcon("action", { actionType: "xAction" })).toBe(XIcon);
  });
});
