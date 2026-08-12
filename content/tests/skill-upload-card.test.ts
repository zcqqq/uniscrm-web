import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/SkillUploadCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";
import apiSource from "../frontend/lib/api.ts?raw";

describe("SkillUploadCard 接线", () => {
  it("用共享的拆包函数，不自己再造一个解析器", () => {
    expect(cardSource).toContain('from "../lib/skill-package"');
    expect(cardSource).toContain("parseSkillFiles");
    expect(cardSource).toContain("unzipToEntries");
  });

  it("三种入口都接上：zip、文件夹、单文件", () => {
    expect(cardSource).toContain("webkitdirectory");
    expect(cardSource).toContain(".zip");
    expect(cardSource).toContain("onDrop");
  });

  // 重名必须先问用户。静默覆盖会让用户丢掉自己写的技能。
  it("重名有覆盖/改名两条出路，且不静默覆盖", () => {
    expect(cardSource).toContain("conflict");
    expect(cardSource).toContain('{ en: "Overwrite", zh: "覆盖" }');
    expect(cardSource).toContain('{ en: "Rename", zh: "改名" }');
  });

  it("文案双语", () => {
    for (const s of ['{ en: "My skills", zh: "我的技能" }',
                     '{ en: "Drag & drop a .zip, a folder, or a SKILL.md", zh: "拖入 .zip、文件夹或 SKILL.md" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("api client 有导入、列出与删除", () => {
    expect(apiSource).toContain("skills:");
    expect(apiSource).toContain("/api/skills/import");
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("SkillUploadCard");
  });
});
