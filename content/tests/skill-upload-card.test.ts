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

  // review finding 1: 409（两个标签页/过期列表）必须能恢复——不重新拉取 existing 的话，
  // isConflict 还是用旧数据算，冲突行永远不会亮起来，Overwrite 按钮也就永远出不来，
  // 用户唯一的路只剩"盲改名字再赌一次"，"两条出路"的承诺就碎在这个分支里。
  it("409 时重新拉取技能列表，让过期导致的冲突行重新亮起", () => {
    const catchStart = cardSource.indexOf("} catch (e");
    const catchEnd = cardSource.indexOf("} finally", catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = cardSource.slice(catchStart, catchEnd);
    // 409 分支内必须调用 reload（不是只在 try 的成功路径里调用一次就完事）——
    // 让 isConflict 用最新的 existing 重新算一遍，冲突行才会亮起来。
    expect(catchBlock).toMatch(/status === 409[\s\S]*?reload\(\)/);
  });

  // review finding 2: overwrite 状态曾经按可编辑的 name 记（Record<name, boolean>）。两行
  // 撞了同一个 name（两个技能文件夹的 frontmatter 都写 name: "Foo"）时，点第一行的"覆盖"
  // 会通过共享的 key 连带解锁第二行——用户只确认了一行，两行的 payload 却都带 overwrite:
  // true 发出去。必须按 ingest 时钉住的稳定 rowId 记，不能再用 name 当 key。
  it("overwrite 状态按行的稳定 id 记，不按可编辑的 name 记（两行重名时互不牵连）", () => {
    expect(cardSource).not.toContain("overwrite[s.name]");
    expect(cardSource).not.toContain("[s.name]: !o[s.name]");
    expect(cardSource).toContain("overwrite[s.rowId]");
    expect(cardSource).toContain("[s.rowId]: !o[s.rowId]");
    // rowId 要在 ingest（parseSkillFiles 之后）一次性分配，且不能用 name 本身当 rowId——
    // 否则又变相退化回按 name 记。
    expect(cardSource).toMatch(/rowId:\s*`r\$\{nextRowId\.current\+\+\}`/);
  });
});
