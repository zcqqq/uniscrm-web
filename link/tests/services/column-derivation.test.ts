import { describe, it, expect } from "vitest";
import {
  columnNameFor,
  contentColumnMap,
  contentD1ValueColumns,
  contentR2ValueColumns,
  eventValueColumns,
  mappedContentPropIds,
  mappedUserPropIds,
  userColumnFor,
  userR2SelectColumns,
  userValueColumns,
  USER_FOLLOW_COLUMNS,
} from "../../../metadata/columns";

// 快照对账：下面每一个 FROZEN_* 都是 2026-08-08 重构前 link/src/services/{content,users,
// r2-entities}.ts 里手写字面量的逐字拷贝。重构后这些清单改为从 metadata/columns.ts 推导，
// 本文件断言推导结果与旧字面量完全一致（集合意义上的一致 —— 列在数组里的顺序只影响
// SELECT/CREATE 语句的文本形态，行以对象返回，无行为意义；顺序被刻意保留的清单
// （eventValueColumns）则精确断言数组）。
//
// 有意的差异只有一处，也是本次重构要修的 bug：processed_video_url / video_transcript /
// translated_subtitle_text 三个 flow-payload-only prop 曾误标 entity:["content"]，它们
// 从来不在任何列清单里 —— 所以下面的冻结值里本来就没有它们，推导结果也不能有。

const FROZEN_CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  view_count: "view_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
  share_count: "share_count",
  cover_image_url: "cover_image_url",
  duration: "duration",
  height: "height",
  width: "width",
  has_face: "has_face",
  content_url: "source_url",
};

const FROZEN_R2_CONTENT_VALUE_COLUMNS = [
  "content_type", "content_text", "title", "summary",
  "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "impression_count", "view_count", "like_count",
  "quote_count", "reply_count", "repost_count", "share_count",
];

const FROZEN_CONTENT_PROBE_COLUMNS = FROZEN_R2_CONTENT_VALUE_COLUMNS.filter((c) => c !== "impression_count");

const FROZEN_USER_VALUE_COLUMNS = [
  "name", "username", "verified_type", "profile_image_url", "description",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
];

const FROZEN_USER_COLUMNS = [
  "id", "channel_id", "channel_type", "source_user_id", "name", "username",
  "is_active", "is_follow", "is_followed", "verified_type", "profile_image_url", "description",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
  "raw_data", "created_at", "updated_at", "is_deleted",
];

const FROZEN_EVENT_VALUE_COLUMNS = ["followers_count", "following_count", "verified_type", "message_text"];

describe("metadata/columns derivation matches the pre-refactor literals", () => {
  it("contentColumnMap() — same propId -> column entries, incl. content_url -> source_url", () => {
    expect(contentColumnMap()).toEqual(FROZEN_CONTENT_COLUMN_MAP);
  });

  it("mappedContentPropIds() — map keys plus source_content_id", () => {
    expect(mappedContentPropIds()).toEqual(
      new Set(["source_content_id", ...Object.keys(FROZEN_CONTENT_COLUMN_MAP)])
    );
  });

  it("contentR2ValueColumns() — same column set as the frozen R2 list", () => {
    expect([...contentR2ValueColumns()].sort()).toEqual([...FROZEN_R2_CONTENT_VALUE_COLUMNS].sort());
  });

  it("contentD1ValueColumns() — the R2 set minus impression_count (the probe projection)", () => {
    expect([...contentD1ValueColumns()].sort()).toEqual([...FROZEN_CONTENT_PROBE_COLUMNS].sort());
  });

  it("userValueColumns() — same column set as the frozen literal (incl. the verified_type exception)", () => {
    expect([...userValueColumns()].sort()).toEqual([...FROZEN_USER_VALUE_COLUMNS].sort());
  });

  it("mappedUserPropIds() — value-column propIds plus source_user_id", () => {
    expect(mappedUserPropIds()).toEqual(new Set(["source_user_id", ...FROZEN_USER_VALUE_COLUMNS]));
  });

  it("userR2SelectColumns() — same set as r2-entities' frozen USER_COLUMNS", () => {
    expect([...userR2SelectColumns()].sort()).toEqual([...FROZEN_USER_COLUMNS].sort());
  });

  it("USER_FOLLOW_COLUMNS unchanged", () => {
    expect([...USER_FOLLOW_COLUMNS]).toEqual(["is_follow", "is_followed"]);
  });

  it("eventValueColumns() — exact array (order preserved: union of eventProps, first seen wins)", () => {
    expect(eventValueColumns()).toEqual(FROZEN_EVENT_VALUE_COLUMNS);
  });

  it("the 3 flow-payload-only props are not columns anywhere", () => {
    for (const dead of ["processed_video_url", "video_transcript", "translated_subtitle_text"]) {
      expect(contentColumnMap(), dead).not.toHaveProperty(dead);
      expect(mappedContentPropIds().has(dead), dead).toBe(false);
      expect(contentR2ValueColumns(), dead).not.toContain(dead);
    }
  });

  it("columnNameFor() keeps propId identity except the documented content_url rename", () => {
    expect(columnNameFor("content_url")).toBe("source_url");
    expect(columnNameFor("view_count")).toBe("view_count");
  });

  it("userColumnFor() resolves real user columns and rejects non-columns loudly", () => {
    expect(userColumnFor("followers_count")).toBe("followers_count");
    expect(userColumnFor("verified_type")).toBe("verified_type");
    expect(userColumnFor("is_follow")).toBe("is_follow");
    expect(() => userColumnFor("message_text")).toThrow(/not a real column/);
    expect(() => userColumnFor("processed_video_url")).toThrow(/not a real column/);
  });
});
