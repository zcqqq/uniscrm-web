import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

// 节点卡片上的条件摘要。卡片常是画布上唯一可见的信息，不标出 OR 等于藏了一半语义。
// 只在 ≥2 条时标：1 条时 AND 与 OR 结果完全相同，标出来只是噪音；0 条时卡片本来就不显示这一行。
export function conditionSummary(count: number, logic: unknown): string {
  const base = `${count} condition${count > 1 ? "s" : ""}`;
  return logic === CONDITION_LOGIC_OR && count >= 2 ? `${base} · any` : base;
}

// 分段控件被点击时该写入什么。返回 null 表示不写 —— 点的是当前已生效的那一段，
// 没有实质改动。不这样做的话，点一下当前高亮项就会 updateNodeData 把 flow 标成 Unsaved，
// 用户按 Back 时被问"要不要保存"，而他什么都没改。
// current 收 unknown：存量 graph 没有这个键，AI 生成的 graph 可能是任意形状。
export function nextConditionLogic(current: unknown, clicked: string): string | null {
  const normalized = current === CONDITION_LOGIC_OR ? CONDITION_LOGIC_OR : CONDITION_LOGIC_AND;
  return clicked === normalized ? null : clicked;
}
