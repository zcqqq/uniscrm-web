import { describe, it, expect } from "vitest";
import { PROPS_X } from "../../../metadata/x";

describe("PROPS_X entity tagging", () => {
  const insightProps = PROPS_X.filter((p) => p.isInsight);
  const userProps = insightProps.filter((p) => p.entity?.includes("user"));
  const contentProps = insightProps.filter((p) => p.entity?.includes("content"));

  it("keeps content-only fields out of the user-entity set", () => {
    const userPropIds = userProps.map((p) => p.propId);
    expect(userPropIds).not.toContain("content_type");
    expect(userPropIds).not.toContain("bookmark_count");
  });

  it("keeps user-only fields out of the content-entity set", () => {
    const contentPropIds = contentProps.map((p) => p.propId);
    expect(contentPropIds).not.toContain("is_follow");
    expect(contentPropIds).not.toContain("followers_count");
  });

  it("includes like_count in both entities since it is a real column on both tables", () => {
    const likeCount = insightProps.find((p) => p.propId === "like_count");
    expect(likeCount?.entity).toEqual(expect.arrayContaining(["user", "content"]));
  });

  it("excludes event-only fields (not real columns on either snapshot table) from both entities", () => {
    const verifiedType = insightProps.find((p) => p.propId === "verified_type");
    const messageText = insightProps.find((p) => p.propId === "message_text");
    expect(verifiedType?.entity ?? []).toHaveLength(0);
    expect(messageText?.entity ?? []).toHaveLength(0);
  });
});
