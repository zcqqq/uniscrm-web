import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("getContentTriggerFields", () => {
  it("still returns X's own-posts fields when passed ContentMetadata_X", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "own:get-posts");
    expect(fields.some((f) => f.id === "content_text")).toBe(true);
  });

  it("returns duration and has_face for the YouTube watch mode", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    expect(fields.map((f) => f.id)).toEqual(expect.arrayContaining(["duration", "has_face"]));
  });

  it("returns an empty array for an unknown sourceContentType", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "nonexistent");
    expect(fields).toEqual([]);
  });
});
