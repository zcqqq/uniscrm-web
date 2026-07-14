import { describe, it, expect } from "vitest";
import { buildEntityColumns } from "../../../shared/frontend/lib/metadata-columns";
import { PROPS } from "../../../metadata/props";
import { DateCell } from "../../../shared/frontend/components/CellDate";

interface Row {
  [key: string]: unknown;
}

describe("buildEntityColumns", () => {
  it("only includes props tagged with the given entity, in declaration order", () => {
    const cols = buildEntityColumns<Row>(PROPS, "user", "en", "UTC");
    const keys = cols.map((c) => c.key);
    expect(keys).toContain("name");
    expect(keys).toContain("followers_count");
    // content-only prop must not leak into the user entity's columns
    expect(keys).not.toContain("content_type");
    expect(keys).not.toContain("bookmark_count");
    // declaration order in PROPS: name appears before followers_count
    expect(keys.indexOf("name")).toBeLessThan(keys.indexOf("followers_count"));
  });

  it("localizes the label via the given locale", () => {
    const en = buildEntityColumns<Row>(PROPS, "user", "en", "UTC");
    const zh = buildEntityColumns<Row>(PROPS, "user", "zh", "UTC");
    const enFollowers = en.find((c) => c.key === "followers_count")!;
    const zhFollowers = zh.find((c) => c.key === "followers_count")!;
    expect(enFollowers.label).toBe("Followers");
    expect(zhFollowers.label).toBe("粉丝数");
  });

  it("only marks INT and DATETIME columns sortable, with an explicit sortType", () => {
    const cols = buildEntityColumns<Row>(PROPS, "content", "en", "UTC");

    const viewCount = cols.find((c) => c.key === "view_count")!;
    expect(viewCount.sortable).toBe(true);
    expect(viewCount.sortType).toBe("number");

    const postedAt = cols.find((c) => c.key === "source_created_at")!;
    expect(postedAt.sortable).toBe(true);
    expect(postedAt.sortType).toBe("date");

    // TEXT and ENUM_TEXT columns must not be sortable — their comparison order
    // isn't well-defined, and R2 SQL-backed pages have no server-side sort to
    // fall back on.
    const title = cols.find((c) => c.key === "title")!;
    expect(title.sortable).toBeFalsy();
    expect(title.sortType).toBeUndefined();

    const contentType = cols.find((c) => c.key === "content_type")!;
    expect(contentType.sortable).toBeFalsy();
    expect(contentType.sortType).toBeUndefined();
  });

  it("renders DATETIME props via the shared DateCell (date + time incl. seconds)", () => {
    const cols = buildEntityColumns<Row>(PROPS, "content", "en", "UTC");
    const postedAt = cols.find((c) => c.key === "source_created_at")!;
    const el = postedAt.render!({ source_created_at: "2026-01-02T03:04:05.000Z" });
    expect((el as any).type).toBe(DateCell);
    expect((el as any).props).toMatchObject({ iso: "2026-01-02T03:04:05.000Z", timezone: "UTC" });
  });

  it("renders ENUM props as their localized enum label, not the raw stored value", () => {
    const cols = buildEntityColumns<Row>(PROPS, "user", "en", "UTC");
    const isFollow = cols.find((c) => c.key === "is_follow")!;
    expect(isFollow.render!({ is_follow: 1 })).toBe("Following");
    expect(isFollow.render!({ is_follow: 0 })).toBe("Not following");
  });

  it("renders IMAGE fieldType props as a thumbnail <img>, not a raw URL string", () => {
    const cols = buildEntityColumns<Row>(PROPS, "user", "en", "UTC");
    const avatar = cols.find((c) => c.key === "profile_image_url")!;
    const el = avatar.render!({ profile_image_url: "https://example.com/a.png" });
    expect((el as any).type).toBe("img");
    expect((el as any).props.src).toBe("https://example.com/a.png");
  });

  it("falls back to an em dash for missing values", () => {
    const cols = buildEntityColumns<Row>(PROPS, "user", "en", "UTC");
    const desc = cols.find((c) => c.key === "description")!;
    expect(desc.render!({})).toBe("—");
  });

  it("content_type prop accepts VIDEO alongside TWEET/ARTICLE", () => {
    const contentTypeProp = PROPS.find((p) => p.propId === "content_type")!;
    const values = contentTypeProp.enums!.map((e) => e.value);
    expect(values).toContain("VIDEO");
  });
});
