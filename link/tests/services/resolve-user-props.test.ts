import { describe, it, expect } from "vitest";
import { resolveUserProps } from "../../src/services/pollers/resolve-user-props";
import type { UserPropMapping } from "../../../metadata/dataTypes";

describe("resolveUserProps", () => {
  const userProps: UserPropMapping[] = [
    { propId: "source_user_id", dataId: "{linkPrefix}.id" },
    { propId: "name", dataId: "{linkPrefix}.name" },
    { propId: "is_followed", value: 1 },
  ];

  it("resolves dataId fields relative to the item", () => {
    const item = { id: "123", name: "Ada", username: "ada" };
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result).toEqual({ source_user_id: "123", name: "Ada", is_followed: 1 });
  });

  it("omits a prop when its dataId resolves to nothing, rather than defaulting", () => {
    const item = { id: "123" }; // no "name"
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result).toEqual({ source_user_id: "123", is_followed: 1 });
    expect(result).not.toHaveProperty("name");
  });

  it("uses static value mappings verbatim regardless of item contents", () => {
    const item = { id: "1", is_followed: 0 }; // item's own field must not override static mapping
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result.is_followed).toBe(1);
  });

  it("works without a linkPrefix (dataId used as-is)", () => {
    const item = { id: "9", name: "Bob" };
    const mapping: UserPropMapping[] = [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
    ];
    const result = resolveUserProps(item, mapping);
    expect(result).toEqual({ source_user_id: "9", name: "Bob" });
  });
});
