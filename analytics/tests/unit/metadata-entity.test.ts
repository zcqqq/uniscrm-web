import { describe, it, expect } from "vitest";
import { PROPS } from "../../../metadata/props";

describe("PROPS entity tagging", () => {
  const insightProps = PROPS.filter((p) => p.isInsight);
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

  // message_text is genuinely event-only (no user/content column). verified_type is NOT —
  // it has been a real `user` column since operation/migrations/0006 — but it deliberately
  // stays untagged: entity also drives the Users list columns (buildEntityColumns) and the
  // analytics user pickers (ReportConfig), and the product keeps verified_type out of both.
  // Storage-wise it is modeled as the explicit USER_EXTRA_VALUE_COLUMNS exception in
  // metadata/columns.ts (see user-stream-schema.test.ts, which reconciles it into the schema).
  it("keeps verified_type (UI-excluded column exception) and message_text (event-only) untagged", () => {
    const verifiedType = insightProps.find((p) => p.propId === "verified_type");
    const messageText = insightProps.find((p) => p.propId === "message_text");
    expect(verifiedType?.entity ?? []).toHaveLength(0);
    expect(messageText?.entity ?? []).toHaveLength(0);
  });
});
