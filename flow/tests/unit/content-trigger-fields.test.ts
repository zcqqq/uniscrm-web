import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";

describe("getContentTriggerFields", () => {
  it("includes exactly the contentProps of the ContentMetadata_X entry matching the given mode", () => {
    const meta = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.map((f) => f.id).sort()).toEqual(meta.contentProps.map((p) => p.propId).sort());
  });

  it("tags every returned field with group: 'content'", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.every((f) => f.group === "content")).toBe(true);
  });

  it("returns a different field set for own:get-posts vs get-list-posts when their contentProps differ, else the same ids", () => {
    const ownFields = getContentTriggerFields(ContentMetadata_X, "own:get-posts", "en");
    const listFields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const ownMeta = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;
    const listMeta = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
    expect(ownFields.map((f) => f.id).sort()).toEqual(ownMeta.contentProps.map((p) => p.propId).sort());
    expect(listFields.map((f) => f.id).sort()).toEqual(listMeta.contentProps.map((p) => p.propId).sort());
  });

  it("returns an empty array for a mode with no matching ContentMetadata_X entry", () => {
    expect(getContentTriggerFields(ContentMetadata_X, "not-a-real-mode", "en")).toEqual([]);
  });

  it("gives ENUM_INT/ENUM_TEXT content props enum operators and options", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const contentType = fields.find((f) => f.id === "content_type");
    expect(contentType?.dataType).toBe("enum");
    expect(contentType?.operators).toEqual(["==", "!="]);
  });
});
