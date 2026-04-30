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
      request<{ user: { id: string; email: string; preferred_location: string } }>(
        `/auth/verify?token=${token}`,
      ),
    me: () => request<{ user: { id: string; email: string; preferred_location: string } }>("/auth/me"),
    logout: () => request("/auth/logout", { method: "POST" }),
  },
  recommendations: {
    get: () => request<{ recommendations: any[] }>("/recommendations"),
  },
  settings: {
    get: () => request<{ preferred_location: string }>("/settings"),
    update: (preferred_location: string) =>
      request<{ ok: boolean; preferred_location: string }>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ preferred_location }),
      }),
  },
};
