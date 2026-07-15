// content/frontend/lib/api.ts
import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error || res.statusText);
  }
  return res.json();
}

export interface LlmCredentialsInfo {
  provider: string | null;
}

export const api = {
  llmCredentials: {
    get: (): Promise<{ credentials: { provider: string } | null }> => request("/api/llm-credentials"),
    save: (provider: "openai" | "anthropic", apiKey: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey }) }),
  },
};
