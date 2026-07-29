import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../../src/engine";

describe("$ref 解析：event. 剥离 / user. 严格", () => {
  it("$event.x 仍按裸键解析（存量 user flow 写法）", () => {
    const payload = { followers_count: 500, following_count: 100 };
    expect(evaluateCondition("followers_count", ">", "$event.following_count", payload)).toBe(true);
  });

  it("$x 按裸键解析", () => {
    const payload = { followers_count: 500, following_count: 100 };
    expect(evaluateCondition("followers_count", ">", "$following_count", payload)).toBe(true);
  });

  it("$user.x 命中 user. 键（双写后的 user flow payload）", () => {
    const payload = { followers_count: 500, "user.followers_count": 500, like_count: 10 };
    expect(evaluateCondition("like_count", "<", "$user.followers_count", payload)).toBe(true);
  });

  it("payload 没有 user. 键时，$user.x 不得降级命中同名裸键", () => {
    // 这是 D6 的坑：content flow 里作者数据抓取失败（配额耗尽/作者被封）时 payload
    // 不带 user.*，若降级，$user.view_count 会命中这个视频自己的播放量，条件照常
    // 求值并给出一个看似合理的错误答案。
    const payload = { like_count: 100, view_count: 5000 };
    expect(evaluateCondition("like_count", ">", "$user.view_count * 0.01", payload)).toBe(false);
  });

  it("撞名：内容侧与作者侧的 like_count 各取各的", () => {
    const payload = { like_count: 10, "user.like_count": 90000 };
    expect(evaluateCondition("like_count", ">", "100", payload)).toBe(false);
    expect(evaluateCondition("user.like_count", ">", "100", payload)).toBe(true);
  });

  it("目标表达式：点赞数 > 作者粉丝数的 1%", () => {
    const hit = { like_count: 150, "user.followers_count": 10000 };
    const miss = { like_count: 50, "user.followers_count": 10000 };
    expect(evaluateCondition("like_count", ">", "$user.followers_count * 0.01", hit)).toBe(true);
    expect(evaluateCondition("like_count", ">", "$user.followers_count * 0.01", miss)).toBe(false);
  });

  it("字符串算子同样走新规则", () => {
    const payload = { content_text: "hello mkbhd", "user.name": "mkbhd", name: "someone else" };
    expect(evaluateCondition("content_text", "contains", "$user.name", payload)).toBe(true);
  });
});

// 字符串侧没有 NaN 这样的哨兵：$user.x 取不到只能替换成空串，而
// "任何字符串".includes("") 恒为 true、"任何字符串" != "" 也几乎恒为 true——作者数据
// 取不到反而让条件**通过**，与 D6/D7 的 fail-closed 承诺相反。
// 真实触发路径：X List Posts trigger + content_text contains $user.username，作者被封或
// 转私密时 X 不在 includes.users[] 里返回他，link 照常发出这条推文但**完全不带 user.***
// （x-list-posts.ts 的既定行为），条件于是通过，下游自动转发/私信就打在一个我们一无所知
// 的作者身上。
describe("字符串算子的 fail-closed：payload 缺 user.* 时不得通过", () => {
  // 作者字段一个都没有——作者被封/转私密时 link 发出的就是这个形状。
  const noAuthor = { content_text: "hello mkbhd", like_count: 100 };

  it("contains：$user.username 取不到时不通过（不得因空串恒真而放行）", () => {
    expect(evaluateCondition("content_text", "contains", "$user.username", noAuthor)).toBe(false);
  });

  it("==：$user.username 取不到时不通过", () => {
    expect(evaluateCondition("content_text", "==", "$user.username", noAuthor)).toBe(false);
  });

  it("!=：$user.username 取不到时同样不通过（fail-closed 不看算子方向）", () => {
    // != 尤其反直觉：空串几乎必然 != 实际值，不短路的话它恒为 true。
    expect(evaluateCondition("content_text", "!=", "$user.username", noAuthor)).toBe(false);
  });

  it("表达式里混着字面量时，缺失的 $user.x 依然让整条不通过", () => {
    expect(evaluateCondition("content_text", "contains", "hello $user.username", noAuthor)).toBe(false);
  });

  it("payload 里有 user.* 时 contains 照常判定（没有误伤正常路径）", () => {
    const withAuthor = { content_text: "hello mkbhd", "user.username": "mkbhd" };
    expect(evaluateCondition("content_text", "contains", "$user.username", withAuthor)).toBe(true);
    expect(evaluateCondition("content_text", "contains", "$user.username", { ...withAuthor, "user.username": "veritasium" })).toBe(false);
  });

  // 以下两条锁死"只收紧 user."：$event.x 与裸 $x 取不到时替换成空串是存量已发布 flow 的
  // 既有语义，翻转它们不在这个分支的范围内。
  it("$event.x 取不到时维持既有语义（空串代入，contains 恒真）", () => {
    expect(evaluateCondition("content_text", "contains", "$event.nope", noAuthor)).toBe(true);
  });

  it("裸 $x 取不到时维持既有语义（空串代入，!= 照常为真）", () => {
    expect(evaluateCondition("content_text", "!=", "$nope", noAuthor)).toBe(true);
  });
});
