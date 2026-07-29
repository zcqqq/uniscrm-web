import { describe, it, expect } from "vitest";
import { resolveAuthorProps } from "../../../src/services/pollers/resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

const X_LIST = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
const YT = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

describe("resolveAuthorProps", () => {
  it("每个键都加上 user. 前缀", () => {
    const author = {
      id: "author-1", name: "MKBHD", username: "mkbhd",
      description: "tech", profile_image_url: "https://x/img", verified_type: "blue",
      public_metrics: { followers_count: 10000, following_count: 5, tweet_count: 300, listed_count: 20, like_count: 90000, media_count: 40 },
    };
    const props = resolveAuthorProps(author, X_LIST.userProps!);
    expect(props["user.source_user_id"]).toBe("author-1");
    expect(props["user.followers_count"]).toBe(10000);
    expect(props["user.post_count"]).toBe(300);
    expect(props["user.like_count"]).toBe(90000);
    // 裸键一个都不能有——否则会覆盖内容侧的同名字段
    expect(Object.keys(props).every((k) => k.startsWith("user."))).toBe(true);
  });

  it("API 没返回的字段不写占位键", () => {
    const props = resolveAuthorProps({ id: "a1" }, X_LIST.userProps!);
    expect(props["user.source_user_id"]).toBe("a1");
    expect("user.followers_count" in props).toBe(false);
  });

  it("YouTube 频道对象映射到同一批 propId", () => {
    const channel = {
      id: "UC123",
      snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t" } } },
      statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
    };
    const props = resolveAuthorProps(channel, YT.userProps!);
    expect(props["user.source_user_id"]).toBe("UC123");
    expect(props["user.name"]).toBe("Chan");
    expect(props["user.followers_count"]).toBe("1000000");
    expect(props["user.post_count"]).toBe("700");
    expect(props["user.view_count"]).toBe("5000000000");
  });
});

describe("ContentMetadata.userProps 的声明范围", () => {
  it("只有 get-list-posts 和 watch:get-videos 声明作者字段", () => {
    const withAuthor = [...ContentMetadata_X, ...ContentMetadata_YouTube]
      .filter((m) => m.userProps && m.userProps.length > 0)
      .map((m) => m.sourceContentType)
      .sort();
    expect(withAuthor).toEqual(["get-list-posts", "watch:get-videos"]);
  });

  it("X 的作者字段不含 is_followed", () => {
    // UserMetadata_X 里它是写死的 { value: 1 }（那份 metadata 是给「拉自己的粉丝列表」
    // 用的），照抄会让每个列表作者恒等于"我的粉丝"，静默且恒真。
    expect(X_LIST.userProps!.some((p) => p.propId === "is_followed")).toBe(false);
  });

  it("作者字段全部只有 dataId、没有写死的 value", () => {
    for (const m of [X_LIST, YT]) {
      for (const p of m.userProps!) {
        expect(p.value, `${m.sourceContentType}/${p.propId}`).toBeUndefined();
        expect(p.dataId, `${m.sourceContentType}/${p.propId}`).toBeTruthy();
      }
    }
  });

  it("作者字段的 dataId 不使用 {linkPrefix}", () => {
    // userProps 的 dataId 相对「作者对象」本身，与 contentProps 的 linkPrefix 无关。
    for (const m of [X_LIST, YT]) {
      for (const p of m.userProps!) {
        expect(p.dataId!.includes("{linkPrefix}"), `${m.sourceContentType}/${p.propId}`).toBe(false);
      }
    }
  });
});
