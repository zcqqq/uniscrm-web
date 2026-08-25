import { describe, it, expect } from "vitest";
import { buildReleaseWindow, isLatestRelease } from "../../src/services/github-release-window";

const NOW = Date.parse("2026-08-24T00:00:00Z");

function rel(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, tag_name: "v1", name: "v1", body: "notes", html_url: "https://gh/r/v1",
    draft: false, prerelease: false,
    published_at: "2026-08-23T00:00:00Z", created_at: "2026-08-23T00:00:00Z",
    ...over,
  };
}

describe("buildReleaseWindow", () => {
  it("只留 maxWaitDays 天内、有 published_at 的条目，带 title/content_text", () => {
    const w = buildReleaseWindow(
      [
        rel({ published_at: "2026-08-23T00:00:00Z" }),               // 1 天内
        rel({ published_at: "2026-08-10T00:00:00Z" }),                // 超出 maxWaitDays=7
        rel({ published_at: null }),                                   // 无发布时间
      ] as never,
      7, false, NOW
    );
    expect(w).toEqual([{ published_at: "2026-08-23T00:00:00Z", title: "v1", content_text: "notes", source_content_id: "1" }]);
  });

  it("默认按 includePrerelease 过滤", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", prerelease: true })] as never,
      7, false, NOW
    );
    expect(w).toEqual([]);
    const w2 = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", prerelease: true })] as never,
      7, true, NOW
    );
    expect(w2).toHaveLength(1);
  });

  it("title 为空时回退 tag_name，和轮询器主路径一致", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", name: null, tag_name: "v1.3.14" })] as never,
      7, false, NOW
    );
    expect(w[0].title).toBe("v1.3.14");
  });

  it("draft 跳过", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", draft: true })] as never,
      7, false, NOW
    );
    expect(w).toEqual([]);
  });

  it("单条正文超过 2000 字截断", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", body: "x".repeat(5_000) })] as never,
      7, false, NOW
    );
    expect(w[0].content_text).toHaveLength(2_000);
  });

  it("累计字节预算耗尽后，后续条目整条不出现（不像 release_history 那样退回空文本形状——这里没有别的用途要保留它们）", () => {
    const releases = Array.from({ length: 40 }, (_, i) =>
      rel({ id: i, published_at: "2026-08-23T00:00:00Z", body: "x".repeat(2_000) })
    );
    const w = buildReleaseWindow(releases as never, 7, false, NOW);
    expect(w.length).toBeGreaterThan(0);
    expect(w.length).toBeLessThan(40);
  });
});

describe("isLatestRelease", () => {
  // id 与发布时间同向递增，和 GitHub 自增 id 的真实语义一致。
  const window = [
    { published_at: "2026-08-23T00:00:00Z", source_content_id: "20" },
    { published_at: "2026-08-22T00:00:00Z", source_content_id: "10" },
  ];

  it("我的发布时间是窗口里最晚的 → true", () => {
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", "20", 7, NOW)).toBe(true);
  });

  it("窗口里有更晚的 → false", () => {
    expect(isLatestRelease(window, "2026-08-22T00:00:00Z", "10", 7, NOW)).toBe(false);
  });

  it("超过 maxWaitDays 强制 true，不管是不是最新", () => {
    const old = Date.parse("2026-08-10T00:00:00Z"); // 14 天前
    expect(isLatestRelease(window, new Date(old).toISOString(), "5", 7, NOW)).toBe(true);
  });

  it("空窗口（我自己都不在里面）时，只要没超 cap 就算最新", () => {
    expect(isLatestRelease([], "2026-08-23T00:00:00Z", "1", 7, NOW)).toBe(true);
  });

  // GitHub 的时间戳只到秒。CI 批量发布时同一秒内落两条 release 完全可能，没有 tie-break
  // 的话两条链各自都判"我是最新的"，两条都会发帖——正是这个节点存在的目的要防止的事。
  it("同一秒内两条 release，id 更大的赢，另一条判 false", () => {
    const window = [
      { published_at: "2026-08-23T00:00:00Z", source_content_id: "10" },
      { published_at: "2026-08-23T00:00:00Z", source_content_id: "20" },
    ];
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", "20", 7, NOW)).toBe(true);
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", "10", 7, NOW)).toBe(false);
  });

  // 纯字符串比较在位数不同时给错答案（"9" > "10"），必须显式转数字。
  it("id 位数不同也按数值比大小，不是字典序", () => {
    const window = [
      { published_at: "2026-08-23T00:00:00Z", source_content_id: "9" },
      { published_at: "2026-08-23T00:00:00Z", source_content_id: "10" },
    ];
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", "10", 7, NOW)).toBe(true);
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", "9", 7, NOW)).toBe(false);
  });
});
