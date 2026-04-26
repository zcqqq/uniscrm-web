import { describe, it, expect } from "vitest";
import { renderTemplate, getTemplate, listFormats } from "../../src/core/templates";
import type { TrendItem, WriteFormat } from "../../src/types";

const sampleTrend: TrendItem = {
  id: "twitter:1",
  platform: "twitter",
  title: "AI Breakthroughs in 2026",
  description: "Major advances in AI this year",
  url: "https://x.com/trend/1",
  score: 95,
  rawMetrics: { tweet_volume: 50000 },
  categories: ["technology"],
  timestamp: "2026-04-25T10:00:00Z",
};

describe("getTemplate", () => {
  it("returns a template for each valid format", () => {
    const formats: WriteFormat[] = ["tweet", "thread", "article", "summary", "headline"];
    for (const f of formats) {
      const tpl = getTemplate(f);
      expect(tpl).toBeDefined();
      expect(tpl.format).toBe(f);
      expect(tpl.template.length).toBeGreaterThan(0);
    }
  });
});

describe("listFormats", () => {
  it("returns 5 formats with format and description", () => {
    const formats = listFormats();
    expect(formats).toHaveLength(5);
    for (const f of formats) {
      expect(f.format).toBeDefined();
      expect(f.description).toBeDefined();
    }
  });
});

describe("renderTemplate", () => {
  it("replaces {trends} placeholder with serialized trend data", () => {
    const result = renderTemplate("tweet", [sampleTrend], {});
    expect(result).toContain("AI Breakthroughs in 2026");
    expect(result).toContain("https://x.com/trend/1");
  });

  it("replaces {tone} with provided value", () => {
    const result = renderTemplate("tweet", [sampleTrend], { tone: "humorous" });
    expect(result).toContain("humorous");
  });

  it("uses default values when options not provided", () => {
    const result = renderTemplate("article", [sampleTrend], {});
    expect(result).toContain("professional");
    expect(result).toContain("zh-CN");
  });
});
