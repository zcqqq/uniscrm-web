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

// lang cookie 由 web worker 在登录与切换语言时写入（domain=uni-scrm.com），全模块同步可读。
// 拿它做初值可以免掉「先渲染英文再跳中文」的闪烁；fetch 回来后再纠偏。
export function localeFromCookie(cookie: string): Locale | null {
  const m = cookie.match(/(?:^|;\s*)lang=([^;]*)/);
  if (!m) return null;
  return m[1] === "zh" || m[1] === "en" ? m[1] : null;
}

export function useLocale(): LocaleState {
  const [state, setState] = useState<LocaleState>(() => ({
    locale: (typeof document !== "undefined" && localeFromCookie(document.cookie)) || "en",
    timezone: "UTC",
    // cookie 只带语言，时区仍要等 fetch，所以这里依旧是 loading。
    loading: true,
  }));

  useEffect(() => {
    let mounted = true;
    fetchMe().then(({ locale, timezone }) => {
      if (mounted) setState({ locale, timezone, loading: false });
    });
    return () => { mounted = false; };
  }, []);

  return state;
}
