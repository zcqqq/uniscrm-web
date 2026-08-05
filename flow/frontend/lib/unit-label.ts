import { t, type Locale } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";

// 节点卡片摘要复用的时长单位文案（分钟/小时/天）——Wait/WaitForEvent/CronTrigger 的
// interval 三处共用同一份译法，与 Inspector.tsx 里同名 <option> 的文案保持一致。
const UNIT_LABELS: Record<string, LocalizedString> = {
  minutes: { en: "minutes", zh: "分钟" },
  hours: { en: "hours", zh: "小时" },
  days: { en: "days", zh: "天" },
};

export function unitLabel(unit: string, locale: Locale): string {
  const found = UNIT_LABELS[unit];
  return found ? t(found, locale) : unit;
}
