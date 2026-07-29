import { Lock } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "../../../shared/frontend/ui/alert";
import { formatDate } from "../../../shared/frontend/lib/format-time";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { t, type Locale } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";

const STRINGS = {
  title: { en: "Account locked by X", zh: "账号被 X 锁定" } as LocalizedString,
  body: {
    en: "X reported this account as locked or suspended, so all API calls for it are paused. Unlock it at x.com/account/access — calls resume by themselves within the hour.",
    zh: "X 报告该账号被锁定或封禁，已暂停对它的所有 API 调用。请在 x.com/account/access 解锁，解锁后一小时内会自动恢复调用。",
  } as LocalizedString,
  since: { en: "Paused since", zh: "暂停于" } as LocalizedString,
};

/**
 * Shown on an X channel card while the freeze breaker is tripped (link/src/services/x-freeze.ts).
 * Without it the card reads "connected" while nothing actually happens — the channel is live but
 * every call is being refused on purpose.
 */
export function FrozenNotice({ frozenAt, locale }: { frozenAt: string; locale: Locale }) {
  const { timezone } = useLocale();
  return (
    <Alert variant="destructive">
      <Lock className="h-4 w-4" />
      <AlertTitle>{t(STRINGS.title, locale)}</AlertTitle>
      <AlertDescription>
        <p>{t(STRINGS.body, locale)}</p>
        <p className="mt-1 opacity-70">
          {t(STRINGS.since, locale)} {formatDate(frozenAt, timezone)}
        </p>
      </AlertDescription>
    </Alert>
  );
}
