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
