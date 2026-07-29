import { navigatePath } from "../../webhook";
import type { PropMapping } from "../../../../metadata/dataTypes";
import { USER_PROP_PREFIX } from "../../../../metadata/dataTypes";

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

// 作者对象 → flow payload 用的作者字段，键统一加 USER_PROP_PREFIX。
// **加前缀的唯一一处**：内容侧与作者侧有 like_count / view_count 等同名 propId，含义
// 完全不同，扁平共用一个 key 空间会让条件静默取到错的那个。metadata 里的 propId 保持
// 干净，前缀是在这里施加的命名空间规则（不是逐字段改名——那才是「propId ≠ field name」
// 那条教训禁止的东西）。
// `author` 是调用方已经取出来的作者对象本身（X：includes.users[] 里按 author_id 匹配到
// 的那条；YouTube：channels.list 的一条 item），所以不传 linkPrefix。
export function resolveAuthorProps(
  author: Record<string, unknown>,
  userProps: PropMapping[]
): Record<string, unknown> {
  const resolved = resolveProps(author, userProps);
  const out: Record<string, unknown> = {};
  for (const [propId, value] of Object.entries(resolved)) {
    out[USER_PROP_PREFIX + propId] = value;
  }
  return out;
}
