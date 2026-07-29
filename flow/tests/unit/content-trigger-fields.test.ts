import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("getContentTriggerFields", () => {
  it("includes exactly the contentProps of the ContentMetadata_X entry matching the given mode", () => {
    // get-list-posts also declares userProps (Task 3 adds those as group:"user" fields), so
    // scope this assertion to the group:"content" subset — the author-field addition is
    // covered separately below in "getContentTriggerFields — 作者字段".
    const meta = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.filter((f) => f.group === "content").map((f) => f.id).sort()).toEqual(meta.contentProps.map((p) => p.propId).sort());
  });

  it("tags every content-only-source field with group: 'content'", () => {
    // own:get-posts declares no userProps, so unlike get-list-posts (which now also yields
    // group:"user" author fields) every field here is still group:"content".
    const fields = getContentTriggerFields(ContentMetadata_X, "own:get-posts", "en");
    expect(fields.every((f) => f.group === "content")).toBe(true);
  });

  it("returns a different field set for own:get-posts vs get-list-posts when their contentProps differ, else the same ids", () => {
    const ownFields = getContentTriggerFields(ContentMetadata_X, "own:get-posts", "en");
    const listFields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const ownMeta = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;
    const listMeta = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
    expect(ownFields.map((f) => f.id).sort()).toEqual(ownMeta.contentProps.map((p) => p.propId).sort());
    expect(listFields.filter((f) => f.group === "content").map((f) => f.id).sort()).toEqual(listMeta.contentProps.map((p) => p.propId).sort());
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

describe("getContentTriggerFields — 作者字段", () => {
  it("X List Posts 的作者字段 id 是限定名、group 是 user", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const followers = fields.find((f) => f.id === "user.followers_count");
    expect(followers).toBeDefined();
    expect(followers!.group).toBe("user");
    // label 保持 prop 自己的标签，靠 SelectPropsValue 的分组标题区分
    expect(followers!.label).not.toContain("user.");
    expect(followers!.dataType).toBe("number");
  });

  it("内容侧与作者侧的 like_count 是两个不同的选项", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.filter((f) => f.id === "like_count" && f.group === "content")).toHaveLength(1);
    expect(fields.filter((f) => f.id === "user.like_count" && f.group === "user")).toHaveLength(1);
  });

  it("YouTube 订阅视频同时有 view_count 与 user.view_count", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    expect(fields.some((f) => f.id === "view_count" && f.group === "content")).toBe(true);
    expect(fields.some((f) => f.id === "user.view_count" && f.group === "user")).toBe(true);
  });

  it("没声明 userProps 的内容源一个 user 分组字段都没有", () => {
    const own = getContentTriggerFields(ContentMetadata_X, "own:get-posts", "en");
    expect(own.some((f) => f.group === "user")).toBe(false);
    expect(own.every((f) => !f.id.startsWith("user."))).toBe(true);
  });

  it("作者字段排在内容字段之后", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const firstUser = fields.findIndex((f) => f.group === "user");
    const lastContent = fields.map((f) => f.group).lastIndexOf("content");
    expect(firstUser).toBeGreaterThan(lastContent);
  });
});
