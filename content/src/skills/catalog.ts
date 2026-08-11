export interface SkillDefinition {
  /** 按技能，如 "marketingskills-social"。已写进 skill_content_cache 与存量 flow 节点的 skillId，不可改名。 */
  id: string;
  label: string;
  sourceUrl: string;
  /** 按包，如 "coreyhaines31/marketingskills"。租户上下文按包存 —— 同包技能共用一份。 */
  repo: string;
}

export const MARKETING_SKILLS_REPO = "coreyhaines31/marketingskills";

const MARKETING_SKILLS_BASE = "https://raw.githubusercontent.com/coreyhaines31/marketingskills/main/skills";

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: "marketingskills-social",
    label: "Social (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/social/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
  {
    id: "marketingskills-image",
    label: "Image (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/image/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
  {
    id: "marketingskills-product-marketing",
    label: "Product Marketing (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/product-marketing/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
];

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}
