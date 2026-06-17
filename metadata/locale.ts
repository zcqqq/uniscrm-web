import type { LocalizedString } from "./dataTypes";

export type Locale = "en" | "zh";

export function t(s: LocalizedString, locale: Locale): string {
  return s[locale] || s.en;
}
