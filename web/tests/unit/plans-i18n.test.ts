import { describe, it, expect } from "vitest";
import { TIERS } from "../../../shared/plans";

// 套餐文案会渲染在账单页、额度页、升级提示与侧边栏上，是纯粹的用户可见文案，
// 必须双语。这里没有「英文回落」——LocalizedString 两个字段都必填。
describe("TIERS 文案双语", () => {
  it("每个套餐的 name 都是双语且两种语言都非空", () => {
    for (const [tier, def] of Object.entries(TIERS)) {
      expect(def.name.en, `${tier}.name.en`).toBeTruthy();
      expect(def.name.zh, `${tier}.name.zh`).toBeTruthy();
    }
  });

  it("每条 description 都是双语且两种语言都非空", () => {
    for (const [tier, def] of Object.entries(TIERS)) {
      const buckets = [def.modules, def.features, def.limits].filter(Boolean);
      for (const bucket of buckets) {
        for (const [key, entry] of Object.entries(bucket as Record<string, any>)) {
          if (!entry.description) continue;
          expect(entry.description.en, `${tier}.${key}.description.en`).toBeTruthy();
          expect(entry.description.zh, `${tier}.${key}.description.zh`).toBeTruthy();
        }
      }
    }
  });

  // 这条守的是那个耦合：标题行原本靠 description 以 "All in" 开头来识别，
  // 翻译后中文不会有这个前缀。改用结构化标志后，标志必须真的存在。
  it("标题行用 isHeader 标志标记，不靠文案前缀识别", () => {
    const headers: string[] = [];
    for (const def of Object.values(TIERS)) {
      for (const bucket of [def.modules, def.features, def.limits].filter(Boolean)) {
        for (const [key, entry] of Object.entries(bucket as Record<string, any>)) {
          if (entry.isHeader) headers.push(key);
        }
      }
    }
    // pro 套餐有一条「All in Basic Plan, plus:」性质的标题行
    expect(headers.length).toBeGreaterThan(0);
  });

  it("没有任何 description 仍以 All in 开头被当作标题用", () => {
    for (const def of Object.values(TIERS)) {
      for (const bucket of [def.modules, def.features, def.limits].filter(Boolean)) {
        for (const entry of Object.values(bucket as Record<string, any>)) {
          if (entry.description?.en?.startsWith("All in")) {
            expect(entry.isHeader, "以 All in 开头的条目必须显式标记 isHeader").toBe(true);
          }
        }
      }
    }
  });
});
