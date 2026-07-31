import { describe, it, expect } from "vitest";
import { conditionsNeedAuthor, youtubeConditionRequest, resolveYouTubeCondition } from "../../src/youtube-condition";

describe("youtubeConditionRequest", () => {
  it("posts the trigger video's id to link's video-stats route", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { source_content_id: "vid123", view_count: "10" },
      withAuthor: false,
    });
    expect(req.url).toBe("https://link/internal/youtube/video-stats");
    expect(JSON.parse(req.body)).toEqual({ videoId: "vid123", contentId: "c1", flowId: "f1", withAuthor: false });
  });

  it("sends an empty videoId rather than 'undefined' when the payload has none", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: null,
      payload: {},
      withAuthor: false,
    });
    expect(JSON.parse(req.body)).toEqual({ videoId: "", contentId: "c1", flowId: null, withAuthor: false });
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

  it("畸形 condition（field/value 非字符串）不抛异常，返回 false", () => {
    // 这个函数在 index.ts 里是在 fetch 的 try/catch 之外调用的——AI 生成的 graph 完全
    // 可能带非字符串的 field/value（UI 的 select 不会产这种形状，但这里不能假设）。
    // 抛出去会逃出 executeContentActions，队列消息整条重试，这一批已执行过的 action
    // 全部重跑一遍。
    expect(() =>
      conditionsNeedAuthor([{ field: 5 as unknown as string, operator: ">", value: "1000" }])
    ).not.toThrow();
    expect(conditionsNeedAuthor([{ field: 5 as unknown as string, operator: ">", value: "1000" }])).toBe(false);

    expect(() =>
      conditionsNeedAuthor([{ field: "like_count", operator: ">", value: 5 as unknown as string }])
    ).not.toThrow();
    expect(conditionsNeedAuthor([{ field: "like_count", operator: ">", value: 5 as unknown as string }])).toBe(false);
  });

  it("Finding B：数组元素本身是 null（不只是 field/value 畸形）不抛异常，结果与忽略它一致", () => {
    // conditionsPass（engine.ts）已经对非对象元素做了防护，但 conditionsNeedAuthor 的
    // typeof c.field 判断在它之前跑——对 c === null 取 c.field 会直接 TypeError，
    // 抛出去同样会让队列消息整条重试。
    const normal = { field: "user.followers_count", operator: ">", value: "1000" };
    const withNull = [null as unknown as { field: string; operator: string; value: string }, normal];
    expect(() => conditionsNeedAuthor(withNull)).not.toThrow();
    expect(conditionsNeedAuthor(withNull)).toBe(conditionsNeedAuthor([normal]));
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

  it("值里引用的是内容字段（非 $user.x）而它从 props 消失时，不升级成 failed —— 这是刻意的范围边界", () => {
    // 守卫只扫值表达式里的 $user.x 引用，不扫 $content_field 引用——这是本任务刻意划定的
    // 范围（scope），不是遗漏。$view_count 这类值侧内容字段引用的陈旧值风险是既有行为，
    // 早于这个 feature，改动会牵动既有条件语义，留给整支分支的最终评审处理。
    // 这条测试钉住当前边界：以后有人想"顺手"把它也纳入或移出这个守卫，测试会提醒他这是
    // 一个决定，不是可以随手改的细节。
    const payload = { source_content_id: "v1", like_count: 10, view_count: 500 };
    const resp = { ok: true, props: { like_count: 150 } }; // view_count 从 props 里消失了
    const out = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "$view_count * 0.1" }],
      payload,
      resp
    );
    // like_count(150) > view_count(500，取自陈旧 payload) * 0.1(=50) → true，而不是 failed。
    expect(out.branch).toBe("true");
    expect(out.failureReason).toBeUndefined();
  });
});

describe("resolveYouTubeCondition — AND/OR", () => {
  const FRESH = { view_count: "100", like_count: "5" };
  const STALE = { view_count: "1", like_count: "1" };
  const HIT = { field: "view_count", operator: ">", value: "50" };
  const MISS = { field: "like_count", operator: ">", value: "500" };

  it("不传 logic 时走 AND：一真一假 → false", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH });
    expect(r.branch).toBe("false");
  });

  it("logic 为 'or' 时一真一假 → true", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH }, "or");
    expect(r.branch).toBe("true");
  });

  it("logic 为 'or' 且全假 → false", () => {
    const r = resolveYouTubeCondition([MISS, MISS], STALE, { ok: true, props: FRESH }, "or");
    expect(r.branch).toBe("false");
  });

  it("logic 为 'or' 且 0 条 → false（AND 下同样输入是 true）", () => {
    expect(resolveYouTubeCondition([], STALE, { ok: true, props: FRESH }, "or").branch).toBe("false");
    expect(resolveYouTubeCondition([], STALE, { ok: true, props: FRESH }).branch).toBe("true");
  });

  it("畸形 logic 走 AND", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH }, true);
    expect(r.branch).toBe("false");
  });

  it("stat_unavailable 守卫与 logic 无关：OR 下另一条已通过，仍然 failed", () => {
    // 设计决策 D6：守卫逐字不改。like_count 在新鲜数据里缺失、旧快照里有 → 整个节点 failed，
    // 即便 view_count 那条在 OR 下已经足以判 true。
    const freshMissingLike = { view_count: "100" };
    const r = resolveYouTubeCondition(
      [HIT, MISS], { view_count: "1", like_count: "1" },
      { ok: true, props: freshMissingLike }, "or"
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toContain("stat_unavailable: like_count");
  });

  it("Finding B：conditions 数组里的 null 元素在 stat_unavailable 守卫循环里不抛异常，结果与忽略它一致", () => {
    // resolveYouTubeCondition 的 stat_unavailable 守卫（`if (!c.field) continue`）跑在
    // conditionsPass 之前，对 c === null 取 c.field 会直接 TypeError——抛出去逃出
    // executeContentActions，队列消息整条重试，这一批已执行过的 action 全部重跑。
    const withNull = [null as unknown as { field: string; operator: string; value: string }, HIT];
    const resp = { ok: true, props: FRESH };
    expect(() => resolveYouTubeCondition(withNull, STALE, resp)).not.toThrow();
    expect(resolveYouTubeCondition(withNull, STALE, resp)).toEqual(resolveYouTubeCondition([HIT], STALE, resp));
  });
});
