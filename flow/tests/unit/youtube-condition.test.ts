import { describe, it, expect } from "vitest";
import { conditionsNeedAuthor, youtubeConditionRequest, resolveYouTubeCondition } from "../../src/youtube-condition";

describe("youtubeConditionRequest", () => {
  it("posts the trigger video's id to link's video-stats route", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { source_content_id: "vid123", view_count: "10" },
    });
    expect(req.url).toBe("https://link/internal/youtube/video-stats");
    expect(JSON.parse(req.body)).toEqual({ videoId: "vid123", contentId: "c1", flowId: "f1" });
  });

  it("sends an empty videoId rather than 'undefined' when the payload has none", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: null,
      payload: {},
    });
    expect(JSON.parse(req.body)).toEqual({ videoId: "", contentId: "c1", flowId: null });
  });
});

describe("resolveYouTubeCondition", () => {
  const stale = { source_content_id: "vid123", view_count: "10", like_count: "1", title: "old" };
  const fresh = { source_content_id: "vid123", view_count: "12000", like_count: "800", title: "new" };

  it("takes the true branch when every condition passes against the fresh props", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1000" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
  });

  it("evaluates against the fresh values, not the trigger-time snapshot", () => {
    // stale.view_count 是 "10"，若判定读的是快照，这条 >1000 会走 false —— 那样整个节点没意义。
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1000" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
    expect(r.payload.view_count).toBe("12000");
    expect(r.payload.title).toBe("new");
  });

  it("takes the false branch when a condition fails", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "99999" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("false");
    expect(r.failureReason).toBeUndefined();
  });

  it("requires ALL conditions to pass (AND)", () => {
    const r = resolveYouTubeCondition(
      [
        { field: "view_count", operator: ">", value: "1000" },
        { field: "like_count", operator: ">", value: "99999" },
      ],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("false");
  });

  it("takes the true branch when there are no conditions at all", () => {
    const r = resolveYouTubeCondition([], stale, { ok: true, props: fresh });
    expect(r.branch).toBe("true");
  });

  it("skips half-filled rows whose field is still empty", () => {
    // Inspector 的 "+ Add" 先插一条空行，用户没选字段就保存了——不该因此判 false。
    const r = resolveYouTubeCondition(
      [{ field: "", operator: "==", value: "" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
  });

  it("merges fresh props over the old payload without dropping keys no condition references", () => {
    // channel_id / content_url 不是 videos.list 的统计量，也没有条件写在它们上面——
    // 保留旧值供下游插值即可。
    const r = resolveYouTubeCondition(
      [],
      { ...stale, channel_id: "ch1", content_url: "https://youtu.be/vid123" },
      { ok: true, props: { view_count: "12000" } }
    );
    expect(r.payload.view_count).toBe("12000");
    expect(r.payload.channel_id).toBe("ch1");
    expect(r.payload.content_url).toBe("https://youtu.be/vid123");
  });

  it("fails rather than judging a condition field the fetch did not return", () => {
    // 作者后来隐藏了点赞数：videos.list 不再返回 statistics.likeCount，resolveProps 于是
    // 不写 like_count。浅合并会把 trigger 时的 "1" 补回来，>0 就假装成立了——那是在判一个
    // 已经不存在的数。
    const r = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "0" }],
      stale,
      { ok: true, props: { source_content_id: "vid123", view_count: "12000" } }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("stat_unavailable: like_count not returned by YouTube");
    expect(r.payload).toEqual(stale);
  });

  it("fails when duration could not be parsed and the payload still holds the old one", () => {
    // link 在 parseISO8601Duration 返回 null 时故意不写 props.duration（P0D = 直播/待发布）。
    const r = resolveYouTubeCondition(
      [{ field: "duration", operator: "<", value: "600" }],
      { ...stale, duration: 200 },
      { ok: true, props: { source_content_id: "vid123", view_count: "12000" } }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("stat_unavailable: duration not returned by YouTube");
  });

  it("reports the first missing field only once, and still merges nothing on failure", () => {
    const r = resolveYouTubeCondition(
      [
        { field: "view_count", operator: ">", value: "1" },
        { field: "like_count", operator: ">", value: "1" },
      ],
      stale,
      { ok: true, props: { view_count: "12000" } }
    );
    expect(r.failureReason).toBe("stat_unavailable: like_count not returned by YouTube");
    expect(r.payload.view_count).toBe("10");
  });

  it("does not fail on a field absent from BOTH the fresh props and the payload", () => {
    // 条件写在了 videos.list 从来不返回的字段上——那不是"这次没取到"，evaluateCondition
    // 本就按缺失值处理，升级成 failed 会把用户的配置错误伪装成 API 故障。
    const r = resolveYouTubeCondition(
      [{ field: "comment_count", operator: ">", value: "1" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("false");
    expect(r.failureReason).toBeUndefined();
  });

  it("ignores the missing-field check for half-filled rows", () => {
    const r = resolveYouTubeCondition(
      [{ field: "", operator: "==", value: "" }],
      stale,
      { ok: true, props: { view_count: "12000" } }
    );
    expect(r.branch).toBe("true");
  });

  it("takes the failed branch and carries link's reason when the fetch did not succeed", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1" }],
      stale,
      { ok: false, reason: "video_unavailable: video not found or private" }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("video_unavailable: video not found or private");
  });

  it("leaves the payload untouched on failure", () => {
    const r = resolveYouTubeCondition([], stale, { ok: false, reason: "youtube_api_error: boom" });
    expect(r.payload).toEqual(stale);
  });

  it("falls back to a generic reason when the failure carries none", () => {
    const r = resolveYouTubeCondition([], stale, { ok: false });
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("youtube_api_error: no reason reported");
  });

  it("treats an ok response with no props as a failure rather than guessing", () => {
    const r = resolveYouTubeCondition([], stale, { ok: true });
    expect(r.branch).toBe("failed");
  });
});

describe("conditionsNeedAuthor", () => {
  it("字段侧引用作者字段 → true", () => {
    expect(conditionsNeedAuthor([{ field: "user.followers_count", operator: ">", value: "1000" }])).toBe(true);
  });

  it("值侧表达式引用作者字段 → true", () => {
    // like_count > $user.followers_count * 0.01 —— 字段侧是内容字段，只有值里有作者引用
    expect(conditionsNeedAuthor([{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }])).toBe(true);
  });

  it("只有内容字段 → false", () => {
    expect(conditionsNeedAuthor([
      { field: "view_count", operator: ">", value: "1000" },
      { field: "like_count", operator: ">", value: "$view_count * 0.01" },
    ])).toBe(false);
  });

  it("空条件 / 半成品条目 → false", () => {
    expect(conditionsNeedAuthor([])).toBe(false);
    expect(conditionsNeedAuthor([{ field: "", operator: "==", value: "" }])).toBe(false);
  });
});

describe("youtubeConditionRequest — withAuthor", () => {
  it("withAuthor 进请求体", () => {
    const { body } = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { source_content_id: "v1" },
      withAuthor: true,
    });
    expect(JSON.parse(body)).toEqual({ videoId: "v1", contentId: "c1", flowId: "f1", withAuthor: true });
  });
});

describe("resolveYouTubeCondition — 作者字段", () => {
  it("合并后的新鲜 props 里作者字段可参与判定", () => {
    const payload = { source_content_id: "v1", like_count: 10, "user.followers_count": 10000 };
    const resp = { ok: true, props: { like_count: 150, "user.followers_count": 10000 } };
    const out = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }],
      payload,
      resp
    );
    expect(out.branch).toBe("true");
    expect(out.payload.like_count).toBe(150);
  });

  it("频道隐藏了订阅数（新数据缺 user.followers_count，旧 payload 有）→ failed", () => {
    // YouTube 允许频道隐藏订阅数（hiddenSubscriberCount），此时 statistics.subscriberCount
    // 不返回。浅合并会把 trigger 时的旧值补回来，条件判的是一个已经不存在的数。
    const payload = { source_content_id: "v1", like_count: 10, "user.followers_count": 10000 };
    const resp = { ok: true, props: { like_count: 150 } };
    const out = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }],
      payload,
      resp
    );
    expect(out.branch).toBe("failed");
    expect(out.failureReason).toContain("stat_unavailable");
    expect(out.failureReason).toContain("user.followers_count");
  });

  it("channel_unavailable 走 failed 分支并原样带上 reason", () => {
    const out = resolveYouTubeCondition(
      [{ field: "user.followers_count", operator: ">", value: "100" }],
      { source_content_id: "v1" },
      { ok: false, reason: "channel_unavailable" }
    );
    expect(out.branch).toBe("failed");
    expect(out.failureReason).toBe("channel_unavailable");
  });
});
