import { describe, it, expect } from "vitest";
import { resolveProps } from "../../src/services/pollers/resolve-props";
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
