import { describe, it, expect } from "vitest";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("ContentMetadata_YouTube actions", () => {
  const actions = ContentMetadata_YouTube.filter((m) => m.flowType === "action");

  it("declares exactly save-to-playlist and rate-like actions", () => {
    expect(actions.map((a) => a.sourceContentType).sort()).toEqual(["rate-like", "save-to-playlist"]);
  });

  it("each action has en+zh label/description and no contentProps", () => {
    for (const a of actions) {
      expect(a.label?.en).toBeTruthy();
      expect(a.label?.zh).toBeTruthy();
      expect(a.description?.en).toBeTruthy();
      expect(a.description?.zh).toBeTruthy();
      expect(a.contentProps).toEqual([]);
    }
  });

  // `price` means 官方费用 (the platform's per-call fee). The YouTube Data API has no
  // per-call fee — it's a free quota system (10,000 units/day, no paid tier), so these
  // actions must NOT declare a price, matching the watch:get-videos trigger above.
  // OperationSelect guards on `price !== undefined`, so no price badge renders.
  it("declares no price, since YouTube charges no per-call fee", () => {
    for (const a of actions) {
      expect(a.price).toBeUndefined();
    }
  });
});
