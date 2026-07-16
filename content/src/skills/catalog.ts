export interface SkillDefinition {
  id: string;
  label: string;
  sourceUrl: string;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: "marketingskills-social",
    label: "Social (marketingskills)",
    sourceUrl: "https://raw.githubusercontent.com/coreyhaines31/marketingskills/main/skills/social/SKILL.md",
  },
];

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}
