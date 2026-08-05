import { useCallback } from "react";
import { t } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { useLocale } from "./useLocale";

// 把 locale 绑进翻译函数，调用处就只剩文案本身：
//   const T = useT();
//   <Button>{T({ en: "Publish", zh: "发布" })}</Button>
//
// 组件之外（列定义工厂之类）继续直接用 metadata/locale 的 t(s, locale) 显式传 locale——
// shared/frontend/lib/metadata-columns.tsx 已经是这个写法。
export function useT(): (s: LocalizedString) => string {
  const { locale } = useLocale();
  return useCallback((s: LocalizedString) => t(s, locale), [locale]);
}
