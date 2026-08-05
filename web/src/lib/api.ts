import { localeFromCookie } from "../../../shared/frontend/hooks/useLocale";
import { t } from "../../../metadata/locale";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" }, // i18n-ok: HTTP header name, not user-facing text
    ...options,
  });
  if (!res.ok) {
    // Fallback for a non-JSON error body (e.g. an upstream proxy's HTML error page); the normal
    // path is the server's own already-bilingual `{ error }` payload, untouched here.
    const locale = (typeof document !== "undefined" && localeFromCookie(document.cookie)) || "en";
    const err = await res.json().catch(() => ({ error: t({ en: "Request failed", zh: "请求失败" }, locale) }));
    throw new Error((err as { error: string }).error);
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    login: (email: string, trial?: string, timezone?: string) =>
      request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, trial, timezone }),
      }),
    passwordLogin: (email: string, password: string) =>
      request<{ ok: boolean; member: { id: string; email: string; preferred_location: string; language: string; timezone: string }; tenant: { id: string; email: string } }>(
        "/auth/password-login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      ),
    verify: (token: string) =>
      request<{ member: { id: string; email: string; preferred_location: string; language: string; timezone: string }; tenant: { id: string; email: string } }>(
        `/auth/verify?token=${token}`,
      ),
    me: () => request<{ member: { id: string; email: string; preferred_location: string; language: string; timezone: string }; tenant: { id: string; email: string } }>("/auth/me"),
    logout: () => request("/auth/logout", { method: "POST" }),
    completeProfile: (email: string) =>
      request("/auth/complete-profile", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    verifyCode: (email: string, code: string) =>
      request<{ ok: boolean; member: { id: string; email: string }; tenant: { id: string; email: string } }>("/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      }),
  },
  recommendations: {
    get: () => request<{ recommendations: any[] }>("/recommendations"),
  },
  billing: {
    getPlans: () => request<{ plans: Array<{ tier: string; name: string; price_monthly: number; currency: string }> }>("/billing/plans"),
    getSubscription: () => request<{ tier: string; status: string; subscription: { id: string; current_period_end: string | null; cancel_at_period_end: number } | null }>("/billing/subscription"),
    subscribe: (tier: string) => request<{ approval_url: string }>("/billing/subscribe", { method: "POST", body: JSON.stringify({ tier }) }),
    cancel: () => request<{ ok: boolean }>("/billing/cancel", { method: "POST" }),
    portal: () => request<{ portal_url: string }>("/billing/portal", { method: "POST" }),
    getCreditUsage: (limit = 50, offset = 0) =>
      request<{
        tier: string;
        monthlyCreditMicros: number;
        usedMicros: number;
        balanceMicros: number;
        periodStart: string | null;
        periodEnd: string | null;
        entries: Array<{ id: string; tenant_id: number; flow_id: string | null; channel_id: string | null; action_event_type: string; credit_micros: number; created_at: string }>;
        total: number;
      }>(`/billing/credit-usage?limit=${limit}&offset=${offset}`),
  },
  settings: {
    get: () => request<{ preferred_location: string; timezone: string; has_password: boolean }>("/settings"),
    setPassword: (new_password: string, current_password?: string) =>
      request<{ ok: boolean }>("/settings/password", {
        method: "POST",
        body: JSON.stringify({ new_password, current_password }),
      }),
    update: (preferred_location: string) =>
      request<{ ok: boolean; preferred_location: string }>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ preferred_location }),
      }),
    updateLanguage: (language: string) =>
      request<{ ok: boolean; language: string }>("/settings/language", {
        method: "PATCH",
        body: JSON.stringify({ language }),
      }),
    updateTimezone: (timezone: string) =>
      request<{ ok: boolean; timezone: string }>("/settings/timezone", {
        method: "PATCH",
        body: JSON.stringify({ timezone }),
      }),
    getLinkedAccounts: () =>
      request<{ accounts: { provider: string; created_at: string }[] }>("/settings/linked-accounts"),
    unlinkAccount: (provider: string) =>
      request("/settings/linked-accounts/" + provider, { method: "DELETE" }),
  },
};
