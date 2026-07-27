import { describe, it, expect } from "vitest";
import { resolveHref } from "../../../shared/frontend/urls";

// Regression: on /content the sidebar's "User Flow" link did nothing. flow's Nav sets
// `flow: ""` so its own menu hrefs stay same-origin relative, but that made the item
// pointing at the module root render as <a href="">, which the browser resolves to the
// *current* URL — a reload, not a navigation. The same shape affects content's
// "AI Content Settings" (content: "") and insight-segment's "Segments" (insightSegment: "").
describe("resolveHref", () => {
  it("turns a blanked self-module base URL into the root path", () => {
    expect(resolveHref("")).toBe("/");
  });

  it("leaves same-origin sub-paths alone", () => {
    expect(resolveHref("/content")).toBe("/content");
  });

  it("leaves cross-module absolute URLs alone", () => {
    expect(resolveHref("https://flow-dev.uni-scrm.com")).toBe("https://flow-dev.uni-scrm.com");
  });
});
