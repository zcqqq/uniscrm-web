import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/MarketingContextCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";

describe("MarketingContextCard 接线", () => {
  // 哨兵围栏方案已废弃（见设计文档 §8.1–§8.2：dev 实测 0/6 合规）。context-block.ts 连同
  // shared 里它依赖的模块都已删除，卡片不该再 import 任何一边。
  it("不再依赖哨兵/解析逻辑", () => {
    expect(cardSource).not.toContain("context-block");
    expect(cardSource).not.toContain("extractContextBlock");
    expect(cardSource).not.toContain("CONTEXT_SENTINEL");
    // 哨兵字面量本身不在这里断言：写出它的值就等于让这个字符串在 content/ 下又出现一次，
    // 而要求正是它必须彻底消失。CONTEXT_SENTINEL 这个名字不再被 import/引用，
    // 已经足以确认卡片没有复活哨兵逻辑。
  });

  // 文档始终活在编辑框里：起草结果和生成结果都要落进 doc 的 state（setDoc），
  // 不能只落进对话区 messages——那样用户又得手动把内容抄进编辑框。
  it("起草结果落进文档 state，不落进对话区", () => {
    expect(cardSource).toContain("const { draft } = await api.marketingContext.draft()");
    expect(cardSource).toContain("setDoc(draft)");
  });

  it("有专门的「生成文档」调用，响应体直接覆盖文档 state", () => {
    expect(cardSource).toContain("api.marketingContext.generate(");
    expect(cardSource).toContain("const { document } = await api.marketingContext.generate(messages, doc)");
    expect(cardSource).toContain("setDoc(document)");
  });

  // 本次修的 bug：真实流程是「帮我起草」把草稿落进编辑框（从不落库）→ 聊几句 → 点「生成
  // 文档」。generate 调用必须带上编辑框当前内容（doc），否则服务端只能去读 D1 里可能没有
  // /过期的存档，看不到用户实际在编辑的东西。
  it("生成文档时把编辑框当前内容（doc）一起发给服务端", () => {
    expect(cardSource).toContain("api.marketingContext.generate(messages, doc)");
  });

  // 不自动保存是这个功能最重要的一条约束：无论起草、对话生成回复、生成文档，都只改本地
  // state；唯一一条会调用 api.marketingContext.save 的路径必须是用户点击保存按钮触发的。
  it("没有任何自动保存路径，save 只在保存按钮的 onClick 里被调用", () => {
    expect(cardSource).not.toContain("autoSave");
    const saveCallSites = cardSource.match(/api\.marketingContext\.save\(/g) ?? [];
    // handleSave 内部一次定义调用点，Save 按钮、以及"先保存再覆盖"对话框各引用一次
    // handleSave —— 但对 api.marketingContext.save 本身而言，唯一调用点应只在 handleSave 里。
    expect(saveCallSites.length).toBe(1);
    expect(cardSource).toContain("onClick={() => handleSave(doc)}");
  });

  // 生成/起草会用服务端响应整体覆盖编辑框；用户手改过还没保存时必须先提醒，否则手改的字
  // 会被静默冲掉（且冲掉后连"曾经打过什么"都无法恢复，因为 generate 端点读的是 D1 里
  // 上一次保存的版本，根本看不到浏览器里未保存的内容）。
  it("覆盖前会检测未保存的手改并弹确认", () => {
    expect(cardSource).toContain("hasUnsavedEdits");
    expect(cardSource).toContain("pendingOverwrite");
    expect(cardSource).toContain("AlertDialog");
  });

  it("文案双语", () => {
    for (const s of ['{ en: "Brand & product context", zh: "品牌与产品上下文" }',
                     '{ en: "Save", zh: "保存" }',
                     '{ en: "Draft it for me", zh: "帮我起草" }',
                     '{ en: "Generate document", zh: "生成文档" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("MarketingContextCard");
  });

  // 409（baseVersion 冲突）不能被通用 catch 一律吞成"请求失败"——否则用户只能反复点、
  // 反复 409，没有任何走出去的路（见 code review 记录）。这条行为在本次改动里原样保留。
  it("保存冲突（409）单独处理，且给出双语提示", () => {
    expect(cardSource).toContain("status === 409");
    expect(cardSource).toContain('en: "This document changed elsewhere. Synced to the latest version — please save again."');
    expect(cardSource).toContain('zh: "这份文档在别处被修改过。已同步到最新版本——请重新点击保存。"');
  });
});
