import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/MarketingContextCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";

describe("MarketingContextCard 接线", () => {
  // 真正的解析逻辑由 context-block.test.ts 实跑；这里只守"卡片确实用的是它，
  // 而不是自己又写了一个宽松的正则"。
  it("用共享的哨兵解析，不自造判断", () => {
    expect(cardSource).toContain('from "../lib/context-block"');
    expect(cardSource).toContain("extractContextBlock");
  });

  // 不自动保存是这个功能最重要的一条约束：一份残缺文档会污染此后所有生成。
  it("保存按钮受解析结果控制，且没有任何自动保存路径", () => {
    expect(cardSource).toContain("savableDoc && (");
    expect(cardSource).not.toContain("autoSave");
  });

  it("文案双语", () => {
    for (const s of ['{ en: "Brand & product context", zh: "品牌与产品上下文" }',
                     '{ en: "Save this document", zh: "保存这份文档" }',
                     '{ en: "Draft it for me", zh: "帮我起草" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("MarketingContextCard");
  });

  // 409（baseVersion 冲突）不能被通用 catch 一律吞成"请求失败"——否则用户只能反复点、
  // 反复 409，没有任何走出去的路（见 code review 记录）。
  it("保存冲突（409）单独处理，且给出双语提示", () => {
    expect(cardSource).toContain("status === 409");
    expect(cardSource).toContain('en: "This document changed elsewhere. Synced to the latest version — please save again."');
    expect(cardSource).toContain('zh: "这份文档在别处被修改过。已同步到最新版本——请重新点击保存。"');
  });
});
