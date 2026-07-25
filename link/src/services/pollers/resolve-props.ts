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
//
// `allowedPropIds`, when given, further restricts to propIds the caller's record builder
// actually has a *column* for. A metadata mapping having a dataId does not mean the target R2
// table has a column for it — X user's profile_image_url/description are real fields with a
// dataId in UserMetadata_X but no R2 `user` column (task-5 fix round, Important 1). Treating
// such a propId as "consumed" strips its value out of raw_data with nowhere else for it to
// land, destroying it permanently. Omitting this parameter keeps the old (unfiltered)
// behavior — every caller that owns a fixed, known column set should pass it.
export function consumedPaths(
  props: PropMapping[],
  linkPrefix?: string,
  allowedPropIds?: Set<string>
): string[] {
  const paths: string[] = [];
  for (const mapping of props) {
    if (mapping.value !== undefined) continue;
    if (!mapping.dataId) continue;
    if (allowedPropIds && !allowedPropIds.has(mapping.propId)) continue;
    const relativePath = linkPrefix
      ? mapping.dataId.replace(`{linkPrefix}.`, "")
      : mapping.dataId;
    paths.push(relativePath);
  }
  return paths;
}
