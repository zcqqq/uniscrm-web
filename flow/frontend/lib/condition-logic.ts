import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";
import type { Locale } from "../../../metadata/locale";

// 节点卡片上的条件摘要。卡片常是画布上唯一可见的信息，不标出 OR 等于藏了一半语义。
// 只在 ≥2 条时标：1 条时 AND 与 OR 结果完全相同，标出来只是噪音；0 条时卡片本来就不显示这一行。
// locale 无默认值——调用方（节点卡片组件）必须传入自己的 useLocale() 结果，避免重蹈
// trigger-fields.ts 的 CHANNEL_TYPES 覆辙（冻结成英文，中文用户永远看不到中文）。
export function conditionSummary(count: number, logic: unknown, locale: Locale): string {
  const base = locale === "zh" ? `${count} 个条件` : `${count} condition${count > 1 ? "s" : ""}`;
  return logic === CONDITION_LOGIC_OR && count >= 2
    ? (locale === "zh" ? `${base}（任一）` : `${base} · any`)
    : base;
}

// 分段控件被点击时该写入什么。返回 null 表示不写 —— 点的是当前已生效的那一段，
// 没有实质改动。不这样做的话，点一下当前高亮项就会 updateNodeData 把 flow 标成 Unsaved，
// 用户按 Back 时被问"要不要保存"，而他什么都没改。
// current 收 unknown：存量 graph 没有这个键，AI 生成的 graph 可能是任意形状。
export function nextConditionLogic(current: unknown, clicked: string): string | null {
  const normalized = current === CONDITION_LOGIC_OR ? CONDITION_LOGIC_OR : CONDITION_LOGIC_AND;
  return clicked === normalized ? null : clicked;
}
