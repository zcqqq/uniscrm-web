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

export interface ProviderCredentialInfo {
  provider: "openai" | "anthropic";
  model: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[] }> => request("/api/llm-credentials"),
    save: (provider: "openai" | "anthropic", apiKey: string, model: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
};
