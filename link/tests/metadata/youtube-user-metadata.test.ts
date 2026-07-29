import { describe, it, expect } from "vitest";
import { UserMetadata_YouTube } from "../../../metadata/youtube";
import { resolveProps, consumedPaths } from "../../src/services/pollers/resolve-props";

const META = UserMetadata_YouTube.find((m) => m.sourceUserType === "own:get-subscriptions")!;

// 一条真实形状的 channels.list item（part=snippet,statistics）。
// 注意 statistics 的数字字段 YouTube 返回的是字符串。
const CHANNEL_ITEM = {
  kind: "youtube#channel",
  id: "UCBJycsmduvYEL83R_U4JriQ",
  snippet: {
    title: "Marques Brownlee",
    description: "MKBHD: Quality Tech Videos",
    customUrl: "@mkbhd",
    publishedAt: "2008-03-21T15:25:54Z",
    thumbnails: {
      default: { url: "https://yt3.ggpht.com/default.jpg", width: 88, height: 88 },
      high: { url: "https://yt3.ggpht.com/high.jpg", width: 800, height: 800 },
    },
    country: "US",
  },
  statistics: {
    viewCount: "4321000000",
    subscriberCount: "19500000",
    hiddenSubscriberCount: false,
    videoCount: "1680",
  },
};

describe("UserMetadata_YouTube own:get-subscriptions", () => {
  it("没有 linkPrefix —— 喂进来的是 channels.list 的单条 item", () => {
    expect(META.linkPrefix).toBeUndefined();
  });

  it("把 channels.list 的字段映射到 user 的 propId 上", () => {
    const props = resolveProps(CHANNEL_ITEM, META.userProps, META.linkPrefix);
    expect(props).toEqual({
      source_user_id: "UCBJycsmduvYEL83R_U4JriQ",
      name: "Marques Brownlee",
      username: "@mkbhd",
      description: "MKBHD: Quality Tech Videos",
      profile_image_url: "https://yt3.ggpht.com/default.jpg",
      followers_count: "19500000",
      post_count: "1680",
      is_follow: 1,
    });
  });

  // 这是整个映射最容易搞错的一条：propId 不等于 payload 字段名。
  // followers_count 来自 subscriberCount，post_count 来自 videoCount。
  it("followers_count 来自 subscriberCount，post_count 来自 videoCount", () => {
    const byId = Object.fromEntries(META.userProps.map((p) => [p.propId, p.dataId]));
    expect(byId.followers_count).toBe("statistics.subscriberCount");
    expect(byId.post_count).toBe("statistics.videoCount");
  });

  // hiddenSubscriberCount 为 true 时 API 不返回 subscriberCount 字段。
  // resolveProps 对缺失路径不写入 key —— 下游据此保持 null 而不是写 0。
  it("subscriberCount 缺席时不产出 followers_count", () => {
    const hidden = { ...CHANNEL_ITEM, statistics: { viewCount: "1000", hiddenSubscriberCount: true, videoCount: "12" } };
    const props = resolveProps(hidden, META.userProps, META.linkPrefix);
    expect("followers_count" in props).toBe(false);
    expect(props.post_count).toBe("12");
  });

  // viewCount / hiddenSubscriberCount / publishedAt / country 都不映射，
  // 因此不在 consumedPaths 里 —— 它们会留在 raw_data 中。
  it("未映射字段不出现在 consumedPaths 里", () => {
    const paths = consumedPaths(META.userProps, META.linkPrefix);
    expect(paths).toContain("statistics.subscriberCount");
    expect(paths).not.toContain("statistics.viewCount");
    expect(paths).not.toContain("snippet.country");
    // is_follow 是固定 value，不消费 payload 任何路径
    expect(paths.some((p) => p.includes("is_follow"))).toBe(false);
  });
});
