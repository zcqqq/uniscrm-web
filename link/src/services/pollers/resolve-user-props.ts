import { navigatePath } from "../../webhook";
import type { UserPropMapping } from "../../../../metadata/dataTypes";

export function resolveUserProps(
  item: Record<string, unknown>,
  userProps: UserPropMapping[],
  linkPrefix?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mapping of userProps) {
    if (mapping.value !== undefined) {
      result[mapping.propId] = mapping.value;
      continue;
    }
    if (!mapping.dataId) continue;
    const relativePath = linkPrefix
      ? mapping.dataId.replace(`{linkPrefix}.`, "")
      : mapping.dataId;
    const resolved = navigatePath(item, relativePath);
    if (resolved !== null && resolved !== undefined) {
      result[mapping.propId] = resolved;
    }
  }
  return result;
}
