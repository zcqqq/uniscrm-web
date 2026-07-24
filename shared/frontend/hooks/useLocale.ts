import { useState, useEffect } from "react";
import type { Locale } from "../../../metadata/locale";

interface LocaleState {
  locale: Locale;
  timezone: string;
  loading: boolean;
}

// One fetch per page load, shared by every component instance (e.g. a grid of
// cards each calling useLocale must not fan out N identical /me requests).
let mePromise: Promise<{ locale: Locale; timezone: string }> | null = null;

function fetchMe(): Promise<{ locale: Locale; timezone: string }> {
  if (!mePromise) {
    mePromise = fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: any) => ({
        locale: (data.member?.language as Locale) || "en",
        timezone: data.member?.timezone || "UTC",
      }))
      .catch(() => {
        mePromise = null; // allow retry on next mount
        return { locale: "en" as Locale, timezone: "UTC" };
      });
  }
  return mePromise;
}

export function useLocale(): LocaleState {
  const [state, setState] = useState<LocaleState>({ locale: "en", timezone: "UTC", loading: true });

  useEffect(() => {
    let mounted = true;
    fetchMe().then(({ locale, timezone }) => {
      if (mounted) setState({ locale, timezone, loading: false });
    });
    return () => { mounted = false; };
  }, []);

  return state;
}
