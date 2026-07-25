import { describe, it, expect } from "vitest";
import { resolveProps, consumedPaths } from "../../src/services/pollers/resolve-props";
import type { PropMapping } from "../../../metadata/dataTypes";

describe("resolveProps", () => {
  const props: PropMapping[] = [
    { propId: "source_user_id", dataId: "{linkPrefix}.id" },
    { propId: "name", dataId: "{linkPrefix}.name" },
    { propId: "is_followed", value: 1 },
  ];

  it("resolves dataId fields relative to the item", () => {
    const item = { id: "123", name: "Ada", username: "ada" };
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({ source_user_id: "123", name: "Ada", is_followed: 1 });
  });

  it("omits a prop when its dataId resolves to nothing, rather than defaulting", () => {
    const item = { id: "123" }; // no "name"
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({ source_user_id: "123", is_followed: 1 });
    expect(result).not.toHaveProperty("name");
  });

  it("uses static value mappings verbatim regardless of item contents", () => {
    const item = { id: "1", is_followed: 0 };
    const result = resolveProps(item, props, "data[]");
    expect(result.is_followed).toBe(1);
  });

  it("works without a linkPrefix (dataId used as-is)", () => {
    const item = { id: "9", name: "Bob" };
    const mapping: PropMapping[] = [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
    ];
    const result = resolveProps(item, mapping);
    expect(result).toEqual({ source_user_id: "9", name: "Bob" });
  });

  it("resolves contentProps-shaped mappings identically (no user-specific logic)", () => {
    const item = { id: "t1", text: "hello world", created_at: "2026-07-11T00:00:00.000Z" };
    const props: PropMapping[] = [
      { propId: "content_type", value: "TWEET" },
      { propId: "source_created_at", dataId: "{linkPrefix}.created_at" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "contentText", dataId: "{linkPrefix}.text" },
    ];
    const result = resolveProps(item, props, "data[]");
    expect(result).toEqual({
      content_type: "TWEET",
      source_created_at: "2026-07-11T00:00:00.000Z",
      source_content_id: "t1",
      contentText: "hello world",
    });
  });
});

describe("consumedPaths", () => {
  // I5: a propId is not a payload field name (view_count ← public_metrics.impression_count),
  // so the old raw_data filter — which matched on propId strings against the payload's own
  // keys — stripped nothing for X content at all. consumedPaths must return the *payload*
  // path, not the propId.
  it("returns the relative payload path for each dataId mapping, not the propId", () => {
    const props: PropMapping[] = [
      { propId: "content_text", dataId: "{linkPrefix}.text" },
      { propId: "view_count", dataId: "{linkPrefix}.public_metrics.impression_count" },
      { propId: "source_created_at", dataId: "{linkPrefix}.created_at" },
    ];
    expect(consumedPaths(props, "data[]")).toEqual([
      "text",
      "public_metrics.impression_count",
      "created_at",
    ]);
  });

  it("excludes static value mappings, which consume nothing from the payload", () => {
    const props: PropMapping[] = [
      { propId: "content_type", value: "TWEET" },
      { propId: "content_text", dataId: "{linkPrefix}.text" },
    ];
    expect(consumedPaths(props, "data[]")).toEqual(["text"]);
  });

  it("excludes mappings with neither dataId nor value", () => {
    const props: PropMapping[] = [{ propId: "orphan" }];
    expect(consumedPaths(props, "data[]")).toEqual([]);
  });

  it("uses dataId as-is when there is no linkPrefix", () => {
    const props: PropMapping[] = [{ propId: "name", dataId: "name" }];
    expect(consumedPaths(props)).toEqual(["name"]);
  });

  // task-5 fix round, Important 1: a mapping having a dataId doesn't mean the caller's
  // record builder has a column for it (X user's profile_image_url/description have a
  // dataId but no R2 `user` column). allowedPropIds lets a caller that owns a fixed column
  // set exclude those from what's treated as "consumed", so their value isn't stripped out
  // of raw_data with nowhere else to land.
  describe("allowedPropIds filter", () => {
    const props: PropMapping[] = [
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "profile_image_url", dataId: "{linkPrefix}.profile_image_url" },
    ];

    it("excludes a mapped propId not present in allowedPropIds", () => {
      expect(consumedPaths(props, "data[]", new Set(["name"]))).toEqual(["name"]);
    });

    it("behaves identically to the unfiltered call when allowedPropIds is omitted", () => {
      expect(consumedPaths(props, "data[]")).toEqual(["name", "profile_image_url"]);
    });

    it("returns nothing when allowedPropIds excludes every mapping", () => {
      expect(consumedPaths(props, "data[]", new Set())).toEqual([]);
    });
  });
});
