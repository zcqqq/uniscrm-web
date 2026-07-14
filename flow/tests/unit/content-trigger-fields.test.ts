import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { PROPS } from "../../../metadata/props";

describe("getContentTriggerFields", () => {
  it("includes every PROPS entry tagged entity: content", () => {
    const fields = getContentTriggerFields("en");
    const expectedIds = PROPS.filter((p) => p.entity?.includes("content")).map((p) => p.propId);
    expect(fields.map((f) => f.id).sort()).toEqual(expectedIds.sort());
  });

  it("excludes user-only props (e.g. followers_count)", () => {
    const fields = getContentTriggerFields("en");
    expect(fields.find((f) => f.id === "followers_count")).toBeUndefined();
  });

  it("gives ENUM_INT/ENUM_TEXT content props enum operators and options", () => {
    const fields = getContentTriggerFields("en");
    const contentType = fields.find((f) => f.id === "content_type");
    expect(contentType?.dataType).toBe("enum");
    expect(contentType?.operators).toEqual(["==", "!="]);
  });
});
