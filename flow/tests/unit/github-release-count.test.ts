import { describe, it, expect } from "vitest";
import { computeReleaseCounts, parseReleaseHistory } from "../../src/github-release-count";

const NOW = Date.parse("2026-08-10T00:00:00Z");
const H = [
  { published_at: "2026-08-09T12:00:00Z", prerelease: false },  // 1d
  { published_at: "2026-08-06T00:00:00Z", prerelease: true },   // 7d，预发布
  { published_at: "2026-07-20T00:00:00Z", prerelease: false },  // 30d
  { published_at: "2026-06-01T00:00:00Z", prerelease: false },  // 窗口外
];

describe("computeReleaseCounts", () => {
  it("默认口径只数正式版", () => {
    expect(computeReleaseCounts(H, false, NOW)).toEqual({
      release_count_1d: 1, release_count_7d: 1, release_count_30d: 2,
    });
  });

  it("includePrerelease 打开时把预发布一起数进来", () => {
    // 计数是「节点相对」的：同一条 release，两个勾选框状态不同的 flow 会看到不同的数。
    // 这是设计 D6 明确接受的结果，不是 bug。
    expect(computeReleaseCounts(H, true, NOW)).toEqual({
      release_count_1d: 1, release_count_7d: 2, release_count_30d: 3,
    });
  });

  it("边界按闭区间：正好 7 天前算在 7d 内", () => {
    const edge = [{ published_at: "2026-08-03T00:00:00Z", prerelease: false }];
    expect(computeReleaseCounts(edge, false, NOW).release_count_7d).toBe(1);
  });

  it("空历史全是 0，不是 undefined —— 条件求值要拿到真实的 0", () => {
    expect(computeReleaseCounts([], false, NOW)).toEqual({
      release_count_1d: 0, release_count_7d: 0, release_count_30d: 0,
    });
  });
});

describe("parseReleaseHistory", () => {
  it("过滤掉畸形条目而不是抛 —— payload 可能被存过一遍 JSON 再取回", () => {
    expect(parseReleaseHistory([
      { published_at: "2026-08-09T00:00:00Z", prerelease: false },
      { published_at: 123, prerelease: false },
      null,
      "nope",
      { prerelease: true },
      { published_at: "not-a-date", prerelease: false },
    ])).toEqual([{ published_at: "2026-08-09T00:00:00Z", prerelease: false }]);
  });

  it("非数组返回空数组", () => {
    expect(parseReleaseHistory(undefined)).toEqual([]);
    expect(parseReleaseHistory({})).toEqual([]);
  });
});
