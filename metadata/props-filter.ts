import type { PropFilter } from "./dataTypes";

// 纯函数，link（内容 trigger 入队前）与 flow（action 执行前）共用。
// 语义见 dataTypes.ts 中 PropFilter 的注释。
export function passesPropsFilter(
  filters: PropFilter[] | undefined,
  props: Record<string, unknown>
): boolean {
  if (!filters?.length) return true;
  return filters.every((f) => {
    const actual = props[f.propId];
    if (f.operator === "==") return actual === f.value;
    if (f.operator === "!=") return actual !== f.value;
    // Fail closed: null and "" coerce to 0 via Number(), not NaN, so guard explicitly.
    if (actual === null || actual === "") return false;
    const a = Number(actual);
    const b = Number(f.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    switch (f.operator) {
      case "<=": return a <= b;
      case "<": return a < b;
      case ">=": return a >= b;
      case ">": return a > b;
      default: return false;
    }
  });
}
