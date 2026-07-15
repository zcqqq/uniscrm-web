import type { Skill } from "./interface";
import { PUNCHY_SOCIAL } from "./punchy-social";
import { PROFESSIONAL_TONE } from "./professional-tone";

export type { Skill };

export const SKILL_CATALOG: Skill[] = [PUNCHY_SOCIAL, PROFESSIONAL_TONE];

export function getSkill(skillId: string): Skill | undefined {
  return SKILL_CATALOG.find((s) => s.id === skillId);
}
