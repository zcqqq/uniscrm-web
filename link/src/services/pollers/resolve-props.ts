import { navigatePath } from "../../webhook";
import type { PropMapping } from "../../../../metadata/dataTypes";

export function resolveProps(
  item: Record<string, unknown>,
  props: PropMapping[],
  linkPrefix?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mapping of props) {
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

// The source paths resolveProps actually consumed, relative to linkPrefix — i.e. exactly the
// payload fields that landed in a named column. raw_data must strip THESE, not the propIds:
// a propId is not a payload field name (view_count ← public_metrics.impression_count), so
// matching on propId names strips nothing at all — that was the bug (「propId ≠ field name」,
// this repo has been burned by this trap before; resolve via dataId, never by propId or a
// string heuristic). Mappings with only a `value` (no dataId) consume nothing from the payload
// and are excluded.
export function consumedPaths(props: PropMapping[], linkPrefix?: string): string[] {
  const paths: string[] = [];
  for (const mapping of props) {
    if (mapping.value !== undefined) continue;
    if (!mapping.dataId) continue;
    const relativePath = linkPrefix
      ? mapping.dataId.replace(`{linkPrefix}.`, "")
      : mapping.dataId;
    paths.push(relativePath);
  }
  return paths;
}
