import { describe, it, expect } from "vitest";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("ContentMetadata_YouTube actions", () => {
  const actions = ContentMetadata_YouTube.filter((m) => m.flowType === "action");

  it("declares exactly save-to-playlist and rate-like actions", () => {
    expect(actions.map((a) => a.sourceContentType).sort()).toEqual(["rate-like", "save-to-playlist"]);
  });

  it("each action has en+zh label/description, a price, and no contentProps", () => {
    for (const a of actions) {
      expect(a.label?.en).toBeTruthy();
      expect(a.label?.zh).toBeTruthy();
      expect(a.description?.en).toBeTruthy();
      expect(a.description?.zh).toBeTruthy();
      expect(typeof a.price).toBe("number");
      expect(a.contentProps).toEqual([]);
    }
  });
});
