import { useState, useEffect } from "react";
import type { Locale } from "../../../metadata/locale";

interface LocaleState {
  locale: Locale;
  timezone: string;
  loading: boolean;
}

export function useLocale(): LocaleState {
  const [state, setState] = useState<LocaleState>({ locale: "en", timezone: "UTC", loading: true });

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: any) => {
        setState({
          locale: (data.member?.language as Locale) || "en",
          timezone: data.member?.timezone || "UTC",
          loading: false,
        });
      })
      .catch(() => setState((s) => ({ ...s, loading: false })));
  }, []);

  return state;
}
