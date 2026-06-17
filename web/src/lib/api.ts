const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error: string }).error);
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    login: (email: string) =>
      request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    verify: (token: string) =>
      request<{ member: { id: string; email: string; preferred_location: string; language: string }; tenant: { id: string; email: string } }>(
        `/auth/verify?token=${token}`,
      ),
    me: () => request<{ member: { id: string; email: string; preferred_location: string; language: string }; tenant: { id: string; email: string } }>("/auth/me"),
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
  },
  settings: {
    get: () => request<{ preferred_location: string }>("/settings"),
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
    getLinkedAccounts: () =>
      request<{ accounts: { provider: string; created_at: string }[] }>("/settings/linked-accounts"),
    unlinkAccount: (provider: string) =>
      request("/settings/linked-accounts/" + provider, { method: "DELETE" }),
  },
};
