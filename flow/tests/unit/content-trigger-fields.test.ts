import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

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

  it("no longer offers content_type on list posts — a fixed value:\"TWEET\" filter filters nothing", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.find((f) => f.id === "content_type")).toBeUndefined();
  });

  it("offers the same YouTube content props to the condition node as to the trigger", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    const ids = fields.map((f) => f.id);
    // 这些是随时间会变、值得一天后复查的字段——少了任何一个，这个节点就没法表达核心场景。
    expect(ids).toContain("view_count");
    expect(ids).toContain("like_count");
    expect(ids).toContain("title");
    expect(ids).toContain("duration");
    // 每个字段都得有可选操作符，否则条件行渲染出来是空的下拉框。
    expect(fields.every((f) => f.operators.length > 0)).toBe(true);
  });
});
