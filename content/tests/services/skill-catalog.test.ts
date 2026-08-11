import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, getSkillDefinition, MARKETING_SKILLS_REPO } from "../../src/skills/catalog";

describe("SKILL_CATALOG", () => {
  it("每条技能都声明自己属于哪个包", () => {
    for (const s of SKILL_CATALOG) {
      expect(s.repo, `${s.id} 缺少 repo`).toBeTruthy();
    }
  });

  // 技能 id 按技能、repo 按包 —— 上下文是按包存的，两者不能混为一谈。
  it("marketing 三件套同属一个包，但 id 各不相同", () => {
    const ids = ["marketingskills-social", "marketingskills-image", "marketingskills-product-marketing"];
    const defs = ids.map((id) => getSkillDefinition(id));
    expect(defs.every(Boolean)).toBe(true);
    expect(new Set(defs.map((d) => d!.repo))).toEqual(new Set([MARKETING_SKILLS_REPO]));
    expect(new Set(defs.map((d) => d!.id)).size).toBe(3);
  });

  it("新技能的 sourceUrl 指向各自的 SKILL.md", () => {
    expect(getSkillDefinition("marketingskills-image")!.sourceUrl).toContain("/skills/image/SKILL.md");
    expect(getSkillDefinition("marketingskills-product-marketing")!.sourceUrl).toContain("/skills/product-marketing/SKILL.md");
  });
});
