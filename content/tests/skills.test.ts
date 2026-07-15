import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, getSkill } from "../src/skills";

describe("skill catalog", () => {
  it("has at least two curated skills, each with an id/label/systemPrompt", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(2);
    for (const skill of SKILL_CATALOG) {
      expect(skill.id).toBeTruthy();
      expect(skill.label).toBeTruthy();
      expect(skill.systemPrompt.length).toBeGreaterThan(20);
    }
  });

  it("getSkill returns the matching skill by id", () => {
    const skill = getSkill("punchy-social");
    expect(skill?.label).toBe("Punchy Social Rewrite");
  });

  it("getSkill returns undefined for an unknown id", () => {
    expect(getSkill("does-not-exist")).toBeUndefined();
  });
});
