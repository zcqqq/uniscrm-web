import { describe, it, expect } from "vitest";
import { computeReleaseCounts, computeReleaseNotes1d, parseReleaseHistory } from "../../src/github-release-count";

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

  it("保留 title/content_text（是字符串时）—— link 侧现在会带上它们", () => {
    expect(parseReleaseHistory([
      { published_at: "2026-08-09T00:00:00Z", prerelease: false, title: "v1.4.0", content_text: "notes" },
    ])).toEqual([{ published_at: "2026-08-09T00:00:00Z", prerelease: false, title: "v1.4.0", content_text: "notes" }]);
  });

  it("title/content_text 不是字符串就丢掉这两个字段，不是丢掉整条", () => {
    expect(parseReleaseHistory([
      { published_at: "2026-08-09T00:00:00Z", prerelease: false, title: 123, content_text: null },
    ])).toEqual([{ published_at: "2026-08-09T00:00:00Z", prerelease: false }]);
  });
});

describe("computeReleaseNotes1d", () => {
  const NOW2 = Date.parse("2026-08-10T00:00:00Z");
  const withText = [
    { published_at: "2026-08-09T12:00:00Z", prerelease: false, title: "v1.4.0", content_text: "dark mode" }, // 1d 内
    { published_at: "2026-08-09T06:00:00Z", prerelease: true, title: "v1.4.0-rc1", content_text: "rc" },      // 1d 内，预发布
    { published_at: "2026-08-06T00:00:00Z", prerelease: false, title: "v1.3.0", content_text: "old" },        // 1d 外
    { published_at: "2026-08-09T18:00:00Z", prerelease: false },                                              // 1d 内但没文本（超出 48h 文本窗口或字节预算）
  ];

  it("默认口径只收正式版、只收窗口内、只收带文本的条目，title/content_text 分开存", () => {
    expect(computeReleaseNotes1d(withText, false, NOW2)).toEqual([
      { title: "v1.4.0", content_text: "dark mode" },
    ]);
  });

  it("includePrerelease 打开时把预发布也收进来", () => {
    expect(computeReleaseNotes1d(withText, true, NOW2)).toEqual([
      { title: "v1.4.0", content_text: "dark mode" },
      { title: "v1.4.0-rc1", content_text: "rc" },
    ]);
  });

  it("空历史返回空数组", () => {
    expect(computeReleaseNotes1d([], false, NOW2)).toEqual([]);
  });
});
